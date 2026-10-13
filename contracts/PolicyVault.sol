// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PolicyVault
/// @notice Holds funds for a user and lets an AI agent move them ONLY within
///         rules the owner sets on-chain. The agent key can never withdraw,
///         change the policy, or approve its own pending actions.
///
///         Every attempt (executed, blocked or pending) emits a `Receipt`
///         event. Blocked attempts do NOT revert, so the receipt is kept
///         on-chain and the UI can show exactly why something was refused.
contract PolicyVault {
    // ---------------------------------------------------------------- types

    enum Outcome {
        Executed,
        Blocked,
        Pending,
        Rejected
    }

    enum Reason {
        None, //                  0  allowed
        Paused, //                1  kill switch is on
        PolicyExpired, //         2  policy expiry has passed
        RecipientNotAllowed, //   3  recipient not on allowlist
        ExceedsPerTxLimit, //     4  amount above per-transaction limit
        ExceedsDailyCap, //       5  would push today's total over the cap
        InsufficientBalance, //   6  vault does not hold enough tokens
        NeedsApproval, //         7  above approval threshold, owner must sign off
        ApprovedByOwner, //       8  pending action approved and executed
        RejectedByOwner //        9  pending action rejected
    }

    struct Policy {
        uint256 perTxLimit; //         max per single payment (token units)
        uint256 dailyCap; //           max total per UTC day (token units)
        uint256 approvalThreshold; //  above this, owner approval is required
        uint64 expiry; //              unix time after which agent is blocked, 0 = never
    }

    struct PendingAction {
        address to;
        uint256 amount;
        bool open;
    }

    // -------------------------------------------------------------- storage

    IERC20 public immutable token;
    address public owner;
    address public agent;
    bool public paused;
    Policy public policy;

    mapping(address => bool) public allowed;
    mapping(uint256 => uint256) public spentOnDay; // day index => amount executed
    mapping(uint256 => PendingAction) public pending; // attempt id => action
    uint256 public attempts; // total attempts so far, also the latest id

    uint256 private _lock = 1;

    // --------------------------------------------------------------- events

    /// @notice One per attempt and one per owner decision on a pending attempt.
    event Receipt(
        uint256 indexed id,
        address indexed agent,
        address indexed to,
        uint256 amount,
        Outcome outcome,
        Reason reason,
        string intent
    );

    event PolicyUpdated(uint256 perTxLimit, uint256 dailyCap, uint256 approvalThreshold, uint64 expiry);
    event AllowlistUpdated(address indexed account, bool isAllowed);
    event AgentUpdated(address indexed newAgent);
    event PausedUpdated(bool isPaused);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // --------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error Reentrant();
    error ZeroAddress();
    error ZeroAmount();
    error BadPolicy();
    error NotPending();
    error TransferFailed();
    /// @dev Thrown by `approve` when the action no longer satisfies the policy.
    error PolicyViolation(Reason reason);

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------- constructor

    constructor(
        address token_,
        address agent_,
        uint256 perTxLimit,
        uint256 dailyCap,
        uint256 approvalThreshold,
        uint64 expiry
    ) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        owner = msg.sender;
        agent = agent_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentUpdated(agent_);
        _setPolicy(perTxLimit, dailyCap, approvalThreshold, expiry);
    }

    // ------------------------------------------------------- owner controls

    function setPolicy(uint256 perTxLimit, uint256 dailyCap, uint256 approvalThreshold, uint64 expiry)
        external
        onlyOwner
    {
        _setPolicy(perTxLimit, dailyCap, approvalThreshold, expiry);
    }

    function setAllowed(address account, bool isAllowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        allowed[account] = isAllowed;
        emit AllowlistUpdated(account, isAllowed);
    }

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    /// @notice Kill switch. While paused every agent attempt is blocked.
    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit PausedUpdated(isPaused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Anyone can top up the vault. Needs a prior token approval.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    /// @notice Only the owner can take funds out. The agent cannot.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------- agent entry

    /// @notice The agent proposes a payment. The contract decides.
    /// @param intent Plain-language request or a hash of it, stored in the receipt only.
    /// @return id Attempt id used to look up the receipt and, if pending, to approve it.
    /// @return outcome Executed, Blocked or Pending.
    function requestPayment(address to, uint256 amount, string calldata intent)
        external
        onlyAgent
        nonReentrant
        returns (uint256 id, Outcome outcome)
    {
        if (amount == 0) revert ZeroAmount();
        id = ++attempts;

        Reason reason = _check(to, amount, true);

        if (reason == Reason.NeedsApproval) {
            pending[id] = PendingAction({to: to, amount: amount, open: true});
            emit Receipt(id, msg.sender, to, amount, Outcome.Pending, reason, intent);
            return (id, Outcome.Pending);
        }

        if (reason != Reason.None) {
            emit Receipt(id, msg.sender, to, amount, Outcome.Blocked, reason, intent);
            return (id, Outcome.Blocked);
        }

        // effects before interaction
        spentOnDay[_today()] += amount;
        _safeTransfer(to, amount);
        emit Receipt(id, msg.sender, to, amount, Outcome.Executed, Reason.None, intent);
        return (id, Outcome.Executed);
    }

    // ----------------------------------------------------- owner decisions

    /// @notice Owner signs off on a pending action. Every other rule is checked
    ///         again at this moment, so a stale approval cannot break the policy.
    function approve(uint256 id) external onlyOwner nonReentrant {
        PendingAction storage p = pending[id];
        if (!p.open) revert NotPending();

        Reason reason = _check(p.to, p.amount, false);
        if (reason != Reason.None) revert PolicyViolation(reason);

        p.open = false;
        spentOnDay[_today()] += p.amount;
        _safeTransfer(p.to, p.amount);
        emit Receipt(id, agent, p.to, p.amount, Outcome.Executed, Reason.ApprovedByOwner, "");
    }

    function reject(uint256 id) external onlyOwner {
        PendingAction storage p = pending[id];
        if (!p.open) revert NotPending();
        p.open = false;
        emit Receipt(id, agent, p.to, p.amount, Outcome.Rejected, Reason.RejectedByOwner, "");
    }

    // ---------------------------------------------------------------- views

    /// @notice What would happen if the agent tried this right now? Used by the UI
    ///         to explain a result before or after the fact.
    function preview(address to, uint256 amount) external view returns (Reason) {
        if (amount == 0) return Reason.ExceedsPerTxLimit;
        return _check(to, amount, true);
    }

    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[_today()];
        return spent >= policy.dailyCap ? 0 : policy.dailyCap - spent;
    }

    function vaultBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ------------------------------------------------------------- internal

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _setPolicy(uint256 perTxLimit, uint256 dailyCap, uint256 approvalThreshold, uint64 expiry) private {
        if (perTxLimit == 0 || dailyCap == 0) revert BadPolicy();
        if (approvalThreshold > perTxLimit) revert BadPolicy();
        policy = Policy(perTxLimit, dailyCap, approvalThreshold, expiry);
        emit PolicyUpdated(perTxLimit, dailyCap, approvalThreshold, expiry);
    }

    /// @dev Order matters: the first failing rule is the reason reported.
    function _check(address to, uint256 amount, bool checkApproval) private view returns (Reason) {
        Policy memory p = policy;

        if (paused) return Reason.Paused;
        if (p.expiry != 0 && block.timestamp > p.expiry) return Reason.PolicyExpired;
        if (!allowed[to]) return Reason.RecipientNotAllowed;
        if (amount > p.perTxLimit) return Reason.ExceedsPerTxLimit;
        if (spentOnDay[_today()] + amount > p.dailyCap) return Reason.ExceedsDailyCap;
        if (token.balanceOf(address(this)) < amount) return Reason.InsufficientBalance;
        if (checkApproval && amount > p.approvalThreshold) return Reason.NeedsApproval;
        return Reason.None;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
