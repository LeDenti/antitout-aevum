// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by the vault (tUSD8 on Aevum, 6 decimals).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Post-quantum signature verifier. On QDay Phase 2 this will be the
/// ML-DSA-65 precompile; on Aevum testnet today it is unset (address(0)) and
/// seals are checked off-chain by the sentinel.
interface IPQVerifier {
    function verify(bytes calldata publicKey, bytes calldata message, bytes calldata signature)
        external
        view
        returns (bool);
}

/// @title ImmuneVault — an immune system for an AI agent that pays in stablecoin.
/// @notice Three layers, like an immune system:
///   1. SELF   — who may act: one scoped session per agent (caps, expiry, PQ key),
///               and a membrane of known recipients.
///   2. STATE  — is the agent healthy: rolling daily spend, strikes, quarantine.
///   3. ACTS   — is each act within the rules: refused acts are not reverted, they
///               are recorded (strike + event + journal) so the attack leaves a trace.
/// Every act carries a `seal` = keccak256(record || ML-DSA-65 signature), chained into
/// an on-chain journal head. Escrowed payments (lock / release on proof / refund
/// after deadline) let the agent pay for work before it is delivered.
contract ImmuneVault {
    // ------------------------------------------------------------------ codes
    uint8 public constant OK = 0;
    uint8 public constant REVOKED = 1;
    uint8 public constant EXPIRED = 2;
    uint8 public constant QUARANTINED = 3;
    uint8 public constant OVER_TX_CAP = 4;
    uint8 public constant OVER_DAILY_CAP = 5;
    uint8 public constant UNKNOWN_RECIPIENT = 6;
    uint8 public constant INSUFFICIENT_FUNDS = 7;
    uint8 public constant HELD_FOR_REVIEW = 8;
    uint8 public constant MISSING_SEAL = 9;
    uint8 public constant BAD_ESCROW_TERMS = 10;

    // ------------------------------------------------------------------ kinds
    uint8 public constant KIND_PAY = 1;
    uint8 public constant KIND_LOCK = 2;
    uint8 public constant KIND_RELEASE = 3;
    uint8 public constant KIND_REFUND = 4;
    uint8 public constant KIND_APPROVE = 5;
    uint8 public constant KIND_REJECT = 6;

    struct Session {
        uint128 perTxCap;
        uint128 dailyCap;
        uint64 validUntil;
        bool active;
        bytes32 pqKeyHash; // keccak256 of the agent's ML-DSA-65 public key (1952 bytes)
    }

    struct Health {
        uint64 windowStart;
        uint128 spentInWindow;
        uint32 strikes;
        uint64 quarantinedUntil;
    }

    struct Escrow {
        address agent;
        address payee;
        uint128 amount;
        uint64 deadline;
        bytes32 condition; // sha256(preimage) — PREIMAGE-SHA-256, as on XRPL
        uint8 state; // 1 locked, 2 released, 3 refunded
    }

    struct Held {
        address agent;
        address to;
        uint128 amount;
        bytes32 seal;
        bool open;
    }

    IERC20 public immutable token;
    address public owner;
    address public guardian; // may only freeze agents, never move funds
    IPQVerifier public pqVerifier; // unset on Aevum testnet (no precompile yet)

    uint32 public strikeLimit;
    uint64 public quarantineSeconds;
    uint128 public reviewThreshold;
    uint64 public constant WINDOW = 1 days;

    mapping(address => Session) public sessions;
    mapping(address => Health) public health;
    mapping(address => bool) public knownRecipient;

    uint256 public lockedTotal; // escrowed + held for review
    Escrow[] public escrows;
    Held[] public held;

    bytes32 public journalHead;
    uint256 public actCount;

    // ----------------------------------------------------------------- events
    event SessionGranted(address indexed agent, uint128 perTxCap, uint128 dailyCap, uint64 validUntil, bytes32 pqKeyHash);
    event SessionRevoked(address indexed agent, address indexed by);
    event RecipientSet(address indexed recipient, bool known);
    event Quarantined(address indexed agent, uint64 until, uint32 strikes);
    event Pardoned(address indexed agent);
    event Act(
        uint256 indexed index,
        uint8 indexed kind,
        address indexed agent,
        address to,
        uint256 amount,
        uint8 code,
        bytes32 seal,
        uint256 ref,
        bytes32 head
    );
    event ParamsSet(uint32 strikeLimit, uint64 quarantineSeconds, uint128 reviewThreshold);
    event GuardianSet(address guardian);
    event PQVerifierSet(address verifier);

    error NotOwner();
    error NotGuardian();
    error NotAgent();
    error BadState();
    error BadPreimage();
    error TooEarly();
    error TransferFailed();
    error PQVerifierUnset();
    error PQKeyMismatch();
    error PQSignatureInvalid();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IERC20 token_,
        address owner_,
        address guardian_,
        uint32 strikeLimit_,
        uint64 quarantineSeconds_,
        uint128 reviewThreshold_
    ) {
        token = token_;
        owner = owner_;
        guardian = guardian_;
        strikeLimit = strikeLimit_;
        quarantineSeconds = quarantineSeconds_;
        reviewThreshold = reviewThreshold_;
        emit ParamsSet(strikeLimit_, quarantineSeconds_, reviewThreshold_);
        emit GuardianSet(guardian_);
    }

    // ============================================================ owner (human)

    function grantSession(address agent, uint128 perTxCap, uint128 dailyCap, uint64 validUntil, bytes32 pqKeyHash)
        external
        onlyOwner
    {
        sessions[agent] = Session(perTxCap, dailyCap, validUntil, true, pqKeyHash);
        delete health[agent];
        emit SessionGranted(agent, perTxCap, dailyCap, validUntil, pqKeyHash);
    }

    /// @notice Instant revocation. The owner or the guardian (sentinel) may call it.
    function revokeSession(address agent) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        sessions[agent].active = false;
        emit SessionRevoked(agent, msg.sender);
    }

    function setRecipient(address recipient, bool known) external onlyOwner {
        knownRecipient[recipient] = known;
        emit RecipientSet(recipient, known);
    }

    function pardon(address agent) external onlyOwner {
        Health storage h = health[agent];
        h.strikes = 0;
        h.quarantinedUntil = 0;
        emit Pardoned(agent);
    }

    function setParams(uint32 strikeLimit_, uint64 quarantineSeconds_, uint128 reviewThreshold_) external onlyOwner {
        strikeLimit = strikeLimit_;
        quarantineSeconds = quarantineSeconds_;
        reviewThreshold = reviewThreshold_;
        emit ParamsSet(strikeLimit_, quarantineSeconds_, reviewThreshold_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setPQVerifier(IPQVerifier verifier) external onlyOwner {
        pqVerifier = verifier;
        emit PQVerifierSet(address(verifier));
    }

    /// @notice Human review of a payment held because it was above `reviewThreshold`.
    function approve(uint256 heldId) external onlyOwner {
        Held storage p = held[heldId];
        if (!p.open) revert BadState();
        p.open = false;
        lockedTotal -= p.amount;
        _send(p.to, p.amount);
        _journal(KIND_APPROVE, p.agent, p.to, p.amount, OK, p.seal, heldId);
    }

    function reject(uint256 heldId) external onlyOwner {
        Held storage p = held[heldId];
        if (!p.open) revert BadState();
        p.open = false;
        lockedTotal -= p.amount;
        _journal(KIND_REJECT, p.agent, p.to, p.amount, OK, p.seal, heldId);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (amount > available()) revert BadState();
        _send(to, amount);
    }

    // ============================================================ agent

    /// @notice Pay a known recipient. Never reverts for a rule breach: the breach is
    /// recorded (strike, event, journal) and the function returns its code.
    function pay(address to, uint128 amount, bytes32 seal) external returns (uint8) {
        return _pay(msg.sender, to, amount, seal);
    }

    /// @notice Same as `pay`, but the ML-DSA-65 signature is checked on-chain.
    /// Usable once QDay publishes its Phase 2 precompile (or any IPQVerifier).
    function payVerified(
        address to,
        uint128 amount,
        bytes calldata record,
        bytes calldata pqPublicKey,
        bytes calldata pqSignature
    ) external returns (uint8) {
        if (address(pqVerifier) == address(0)) revert PQVerifierUnset();
        if (keccak256(pqPublicKey) != sessions[msg.sender].pqKeyHash) revert PQKeyMismatch();
        if (!pqVerifier.verify(pqPublicKey, record, pqSignature)) revert PQSignatureInvalid();
        return _pay(msg.sender, to, amount, keccak256(abi.encodePacked(record, pqSignature)));
    }

    function _pay(address agent, address to, uint128 amount, bytes32 seal) internal returns (uint8 code) {
        code = _check(agent, to, amount, seal);
        if (code != OK) {
            _refuse(KIND_PAY, agent, to, amount, code, seal);
            return code;
        }
        _spend(agent, amount);
        if (reviewThreshold != 0 && amount > reviewThreshold) {
            held.push(Held(agent, to, amount, seal, true));
            lockedTotal += amount;
            _journal(KIND_PAY, agent, to, amount, HELD_FOR_REVIEW, seal, held.length - 1);
            return HELD_FOR_REVIEW;
        }
        _send(to, amount);
        _journal(KIND_PAY, agent, to, amount, OK, seal, 0);
    }

    /// @notice Escrow (dareskro): lock funds for a known payee, released to the payee on
    /// proof (preimage of `condition`) or refunded to the vault after `deadline`.
    function lock(address payee, uint128 amount, uint64 deadline, bytes32 condition, bytes32 seal)
        external
        returns (uint8 code, uint256 escrowId)
    {
        code = _check(msg.sender, payee, amount, seal);
        if (code == OK && (deadline <= block.timestamp || condition == bytes32(0))) code = BAD_ESCROW_TERMS;
        if (code != OK) {
            _refuse(KIND_LOCK, msg.sender, payee, amount, code, seal);
            return (code, type(uint256).max);
        }
        _spend(msg.sender, amount);
        escrows.push(Escrow(msg.sender, payee, amount, deadline, condition, 1));
        escrowId = escrows.length - 1;
        lockedTotal += amount;
        _journal(KIND_LOCK, msg.sender, payee, amount, OK, seal, escrowId);
    }

    /// @notice Anyone holding the proof (preimage) can release the escrow to its payee.
    function release(uint256 escrowId, bytes calldata preimage) external {
        Escrow storage e = escrows[escrowId];
        if (e.state != 1) revert BadState();
        if (sha256(preimage) != e.condition) revert BadPreimage();
        e.state = 2;
        lockedTotal -= e.amount;
        _send(e.payee, e.amount);
        _journal(KIND_RELEASE, e.agent, e.payee, e.amount, OK, sha256(preimage), escrowId);
    }

    /// @notice After the deadline, anyone can return unreleased funds to the vault.
    function refund(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        if (e.state != 1) revert BadState();
        if (block.timestamp < e.deadline) revert TooEarly();
        e.state = 3;
        lockedTotal -= e.amount;
        _journal(KIND_REFUND, e.agent, e.payee, e.amount, OK, bytes32(0), escrowId);
    }

    // ============================================================ views

    function available() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > lockedTotal ? bal - lockedTotal : 0;
    }

    function escrowCount() external view returns (uint256) {
        return escrows.length;
    }

    function heldCount() external view returns (uint256) {
        return held.length;
    }

    /// @notice Dry run: what would `pay` answer right now? (for the agent and the UI)
    function preview(address agent, address to, uint128 amount, bytes32 seal) external view returns (uint8) {
        return _check(agent, to, amount, seal);
    }

    // ============================================================ internals

    function _check(address agent, address to, uint128 amount, bytes32 seal) internal view returns (uint8) {
        Session storage s = sessions[agent];
        if (s.validUntil == 0) revert NotAgent(); // never granted: nothing to record
        if (!s.active) return REVOKED;
        if (block.timestamp > s.validUntil) return EXPIRED;
        if (health[agent].quarantinedUntil > block.timestamp) return QUARANTINED;
        if (seal == bytes32(0)) return MISSING_SEAL;
        if (!knownRecipient[to]) return UNKNOWN_RECIPIENT;
        if (amount > s.perTxCap) return OVER_TX_CAP;
        Health storage h = health[agent];
        uint256 spent = block.timestamp >= h.windowStart + WINDOW ? 0 : h.spentInWindow;
        if (spent + amount > s.dailyCap) return OVER_DAILY_CAP;
        if (amount > available()) return INSUFFICIENT_FUNDS;
        return OK;
    }

    function _spend(address agent, uint128 amount) internal {
        Health storage h = health[agent];
        if (block.timestamp >= h.windowStart + WINDOW) {
            h.windowStart = uint64(block.timestamp);
            h.spentInWindow = 0;
        }
        h.spentInWindow += amount;
    }

    function _refuse(uint8 kind, address agent, address to, uint256 amount, uint8 code, bytes32 seal) internal {
        Health storage h = health[agent];
        // A refusal while already quarantined, revoked or expired is recorded but
        // does not stack strikes: the door is already shut.
        if (code != QUARANTINED && code != REVOKED && code != EXPIRED) {
            h.strikes += 1;
            if (strikeLimit != 0 && h.strikes >= strikeLimit) {
                h.quarantinedUntil = uint64(block.timestamp) + quarantineSeconds;
                h.strikes = 0;
                emit Quarantined(agent, h.quarantinedUntil, strikeLimit);
            }
        }
        _journal(kind, agent, to, amount, code, seal, 0);
    }

    function _journal(uint8 kind, address agent, address to, uint256 amount, uint8 code, bytes32 seal, uint256 ref)
        internal
    {
        uint256 index = actCount++;
        journalHead = keccak256(
            abi.encode(journalHead, index, kind, agent, to, amount, code, seal, ref, block.timestamp)
        );
        emit Act(index, kind, agent, to, amount, code, seal, ref, journalHead);
    }

    function _send(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
