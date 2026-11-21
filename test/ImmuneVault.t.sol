// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ImmuneVault, IERC20, IPQVerifier} from "../src/ImmuneVault.sol";

contract MockUSD8 {
    string public constant symbol = "tUSD8";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Stand-in for QDay's future ML-DSA-65 precompile: accepts one (pk, msg, sig) triple.
contract MockPQVerifier is IPQVerifier {
    bytes32 public good;

    function setGood(bytes calldata pk, bytes calldata m, bytes calldata sig) external {
        good = keccak256(abi.encode(pk, m, sig));
    }

    function verify(bytes calldata pk, bytes calldata m, bytes calldata sig) external view returns (bool) {
        return keccak256(abi.encode(pk, m, sig)) == good;
    }
}

contract ImmuneVaultTest is Test {
    MockUSD8 usd8;
    ImmuneVault vault;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address agent = makeAddr("agent");
    address supplier = makeAddr("supplier");
    address freelancer = makeAddr("freelancer");
    address attacker = makeAddr("attacker");

    uint128 constant U = 1e6; // 1 tUSD8
    bytes32 constant SEAL = keccak256("sealed record");
    bytes32 constant PQKEY = keccak256("pq public key");

    function setUp() public {
        vm.warp(1_800_000_000);
        usd8 = new MockUSD8();
        vault = new ImmuneVault(IERC20(address(usd8)), owner, guardian, 3, 1 hours, 50 * U);
        usd8.mint(address(vault), 1_000 * U);
        vm.startPrank(owner);
        vault.grantSession(agent, 100 * U, 150 * U, uint64(block.timestamp + 7 days), PQKEY);
        vault.setRecipient(supplier, true);
        vault.setRecipient(freelancer, true);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- SELF

    function test_pay_within_rules() public {
        vm.prank(agent);
        uint8 code = vault.pay(supplier, 20 * U, SEAL);
        assertEq(code, vault.OK());
        assertEq(usd8.balanceOf(supplier), 20 * U);
        assertEq(vault.actCount(), 1);
    }

    function test_stranger_cannot_act_at_all() public {
        vm.prank(attacker);
        vm.expectRevert(ImmuneVault.NotAgent.selector);
        vault.pay(attacker, 1 * U, SEAL);
    }

    function test_unknown_recipient_refused_and_recorded() public {
        vm.prank(agent);
        uint8 code = vault.pay(attacker, 10 * U, SEAL);
        assertEq(code, vault.UNKNOWN_RECIPIENT());
        assertEq(usd8.balanceOf(attacker), 0);
        (,, uint32 strikes,) = vault.health(agent);
        assertEq(strikes, 1);
        assertEq(vault.actCount(), 1); // the refusal is in the journal
    }

    function test_per_tx_cap() public {
        vm.prank(agent);
        assertEq(vault.pay(supplier, 101 * U, SEAL), vault.OVER_TX_CAP());
    }

    function test_daily_cap_rolls_over() public {
        vm.startPrank(agent);
        assertEq(vault.pay(supplier, 50 * U, SEAL), vault.OK());
        assertEq(vault.pay(supplier, 50 * U, SEAL), vault.OK());
        assertEq(vault.pay(supplier, 50 * U, SEAL), vault.OK());
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.OVER_DAILY_CAP());
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.pay(supplier, 50 * U, SEAL), vault.OK());
        vm.stopPrank();
    }

    function test_missing_seal_refused() public {
        vm.prank(agent);
        assertEq(vault.pay(supplier, 1 * U, bytes32(0)), vault.MISSING_SEAL());
    }

    function test_expired_session() public {
        vm.warp(block.timestamp + 8 days);
        vm.prank(agent);
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.EXPIRED());
    }

    // ---------------------------------------------------------------- STATE

    function test_three_strikes_quarantine_then_heals() public {
        vm.startPrank(agent);
        vault.pay(attacker, 1 * U, SEAL);
        vault.pay(attacker, 1 * U, SEAL);
        vault.pay(attacker, 1 * U, SEAL);
        // quarantined: even a legitimate payment is refused (immune cost)
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.QUARANTINED());
        vm.stopPrank();
        (,,, uint64 until) = vault.health(agent);
        assertEq(until, block.timestamp + 1 hours);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(agent);
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.OK());
    }

    function test_owner_pardon_lifts_quarantine() public {
        vm.startPrank(agent);
        for (uint256 i; i < 3; i++) vault.pay(attacker, 1 * U, SEAL);
        vm.stopPrank();
        vm.prank(owner);
        vault.pardon(agent);
        vm.prank(agent);
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.OK());
    }

    function test_guardian_revokes_instantly_but_cannot_move_funds() public {
        vm.prank(guardian);
        vault.revokeSession(agent);
        vm.prank(agent);
        assertEq(vault.pay(supplier, 1 * U, SEAL), vault.REVOKED());
        vm.prank(guardian);
        vm.expectRevert(ImmuneVault.NotOwner.selector);
        vault.withdraw(guardian, 1 * U);
        vm.prank(guardian);
        vm.expectRevert(ImmuneVault.NotOwner.selector);
        vault.grantSession(guardian, 1, 1, uint64(block.timestamp + 1), PQKEY);
    }

    function test_stranger_cannot_revoke() public {
        vm.prank(attacker);
        vm.expectRevert(ImmuneVault.NotGuardian.selector);
        vault.revokeSession(agent);
    }

    // ---------------------------------------------------------------- ACTS: review

    function test_large_payment_held_for_human_review() public {
        vm.prank(agent);
        assertEq(vault.pay(supplier, 80 * U, SEAL), vault.HELD_FOR_REVIEW());
        assertEq(usd8.balanceOf(supplier), 0);
        assertEq(vault.available(), 920 * U);
        vm.prank(owner);
        vault.approve(0);
        assertEq(usd8.balanceOf(supplier), 80 * U);
        vm.prank(owner);
        vm.expectRevert(ImmuneVault.BadState.selector);
        vault.approve(0);
    }

    function test_held_payment_rejected() public {
        vm.prank(agent);
        vault.pay(supplier, 80 * U, SEAL);
        vm.prank(owner);
        vault.reject(0);
        assertEq(usd8.balanceOf(supplier), 0);
        assertEq(vault.available(), 1_000 * U);
    }

    // ---------------------------------------------------------------- ACTS: escrow (dareskro)

    function test_escrow_release_on_proof() public {
        bytes memory proof = "delivery: invoice INV-42 accepted";
        bytes32 condition = sha256(proof); // compute before prank: sha256 is a precompile call
        vm.prank(agent);
        (uint8 code, uint256 id) = vault.lock(freelancer, 40 * U, uint64(block.timestamp + 2 days), condition, SEAL);
        assertEq(code, vault.OK());
        assertEq(vault.available(), 960 * U);
        vm.expectRevert(ImmuneVault.BadPreimage.selector);
        vault.release(id, "wrong proof");
        vm.prank(freelancer); // anyone holding the proof
        vault.release(id, proof);
        assertEq(usd8.balanceOf(freelancer), 40 * U);
        vm.expectRevert(ImmuneVault.BadState.selector);
        vault.release(id, proof);
    }

    function test_escrow_refund_after_deadline_only() public {
        bytes32 condition = sha256("x");
        vm.prank(agent);
        (, uint256 id) = vault.lock(freelancer, 40 * U, uint64(block.timestamp + 2 days), condition, SEAL);
        vm.expectRevert(ImmuneVault.TooEarly.selector);
        vault.refund(id);
        vm.warp(block.timestamp + 2 days);
        vault.refund(id);
        assertEq(vault.available(), 1_000 * U);
        assertEq(usd8.balanceOf(freelancer), 0);
    }

    function test_escrow_obeys_membrane_and_terms() public {
        vm.startPrank(agent);
        (uint8 c1,) = vault.lock(attacker, 10 * U, uint64(block.timestamp + 1 days), sha256("x"), SEAL);
        assertEq(c1, vault.UNKNOWN_RECIPIENT());
        (uint8 c2,) = vault.lock(freelancer, 10 * U, uint64(block.timestamp), sha256("x"), SEAL);
        assertEq(c2, vault.BAD_ESCROW_TERMS());
        vm.stopPrank();
    }

    function test_locked_funds_cannot_be_spent_or_withdrawn() public {
        vm.prank(owner);
        vault.withdraw(owner, 900 * U);
        bytes32 condition = sha256("x");
        vm.prank(agent);
        vault.lock(freelancer, 90 * U, uint64(block.timestamp + 1 days), condition, SEAL);
        vm.prank(agent);
        assertEq(vault.pay(supplier, 20 * U, SEAL), vault.INSUFFICIENT_FUNDS());
        vm.prank(owner);
        vm.expectRevert(ImmuneVault.BadState.selector);
        vault.withdraw(owner, 20 * U);
    }

    // ---------------------------------------------------------------- journal

    function test_journal_head_chains_every_act() public {
        bytes32 h0 = vault.journalHead();
        vm.prank(agent);
        vault.pay(supplier, 1 * U, SEAL);
        bytes32 h1 = vault.journalHead();
        vm.prank(agent);
        vault.pay(attacker, 1 * U, SEAL);
        bytes32 h2 = vault.journalHead();
        assertTrue(h0 != h1 && h1 != h2);
        bytes32 expected = keccak256(
            abi.encode(h1, uint256(1), vault.KIND_PAY(), agent, attacker, uint256(1 * U), vault.UNKNOWN_RECIPIENT(), SEAL, uint256(0), block.timestamp)
        );
        assertEq(h2, expected);
    }

    // ---------------------------------------------------------------- PQ (Phase 2 path)

    function test_payVerified_needs_verifier() public {
        vm.prank(agent);
        vm.expectRevert(ImmuneVault.PQVerifierUnset.selector);
        vault.payVerified(supplier, 1 * U, "r", "pk", "sig");
    }

    function test_payVerified_with_mock_precompile() public {
        MockPQVerifier v = new MockPQVerifier();
        bytes memory pk = "pq public key";
        bytes memory rec = "record";
        bytes memory sig = "signature";
        v.setGood(pk, rec, sig);
        vm.prank(owner);
        vault.setPQVerifier(v);

        vm.prank(agent);
        vm.expectRevert(ImmuneVault.PQSignatureInvalid.selector);
        vault.payVerified(supplier, 1 * U, rec, pk, "forged");

        vm.prank(agent);
        vm.expectRevert(ImmuneVault.PQKeyMismatch.selector);
        vault.payVerified(supplier, 1 * U, rec, "other key", sig);

        vm.prank(agent);
        assertEq(vault.payVerified(supplier, 1 * U, rec, pk, sig), vault.OK());
        assertEq(usd8.balanceOf(supplier), 1 * U);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_never_pays_over_caps(uint128 a, uint128 b) public {
        a = uint128(bound(a, 1, 300 * U));
        b = uint128(bound(b, 1, 300 * U));
        vm.startPrank(agent);
        vault.pay(supplier, a, SEAL);
        vault.pay(supplier, b, SEAL);
        vm.stopPrank();
        uint256 paidOrHeld = usd8.balanceOf(supplier) + vault.lockedTotal();
        assertLe(paidOrHeld, 150 * U);
        assertLe(usd8.balanceOf(supplier), 100 * U); // anything above 50 is held for review
    }
}
