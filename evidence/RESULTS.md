# Measured run on QDay Aevum testnet

Run 2026-11-21T18:24:23.479Z → 2026-11-21T18:28:51.908Z · chain 44005 · vault [`0x4122869db62e124ecdc5a958ace83059f8818cbd`](https://explorer-test.qday.info/address/0x4122869db62e124ecdc5a958ace83059f8818cbd) · tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`

Policy: 0.10 tUSD8 per payment, 0.30 tUSD8 per 24 h, payments above 0.06 tUSD8 wait for a human, 3 strikes → 600 s quarantine, session valid 7 days. Agent ML-DSA-65 key hash `0x29e18c941cce055a32034ca664b7b56096e976beae2df28f3710b6a464806734`.

| # | Step | Signer | Vault answer | Transaction | Block | Gas |
|---|------|--------|--------------|-------------|-------|-----|
| 1 | deploy ImmuneVault | owner | ok | [0xdbb2d115…](https://explorer-test.qday.info/tx/0xdbb2d115fdd2c29f57a1a61138595149397975d206ab7dee4524d4b82a094c75) | 3768301 | 2163078 |
| 2 | SELF: grant agent session (0.10/tx, 0.30/day, 7 days, PQ key) | owner | ok | [0xf5e93c48…](https://explorer-test.qday.info/tx/0xf5e93c48131735e636e4b5f1708eee7bf256330289a347352588ca29337996c9) | 3768314 | 98887 |
| 3 | SELF: membrane — supplier is known | owner | ok | [0xbd851a8a…](https://explorer-test.qday.info/tx/0xbd851a8a3c4d6d71bee9b6c5aebf15e9e9b4afc823f1c24e30c5aa45d7a121ab) | 3768320 | 47853 |
| 4 | SELF: membrane — freelancer is known | owner | ok | [0x2d1359a8…](https://explorer-test.qday.info/tx/0x2d1359a8783b9132db01d3e50ddf836f3c8c9ee3669991fa37ce23b44014772c) | 3768326 | 47853 |
| 5 | fund vault with 0.50 tUSD8 | owner | ok | [0xbcd10ca1…](https://explorer-test.qday.info/tx/0xbcd10ca17d3063b06a65a24199d726a1c60e86548f16573e86c8bb16bf1daae7) | 3768331 | 62383 |
| 6 | ACTS: invoice INV-101 — pay 0.03 tUSD8 to supplier | agent | OK | [0x15a8c1df…](https://explorer-test.qday.info/tx/0x15a8c1df172ed37fe6b4bd5dd61032f6ac13b9b58e0e630749fa9024c07416c0) | 3768334 | 137252 |
| 7 | ACTS: invoice INV-102 (prompt injection) — pay 0.40 tUSD8 to attacker | agent | UNKNOWN_RECIPIENT | [0xf92ce4d9…](https://explorer-test.qday.info/tx/0xf92ce4d9edc8ecc85188279ea061abc2b97c5d93c546ac8556c7d20c715abf04) | 3768344 | 52111 |
| 8 | ACTS: invoice INV-103 (above per-tx cap) — pay 0.12 tUSD8 to supplier | agent | OVER_TX_CAP | [0x2bf556ad…](https://explorer-test.qday.info/tx/0x2bf556ad4b5731e9aee561b065140ef4a613fffce9099d63158e55fd1f603092) | 3768367 | 54267 |
| 9 | ACTS: invoice INV-104 (injection, 3rd strike) — pay 0.09 tUSD8 to attacker | agent | UNKNOWN_RECIPIENT | [0x937312ac…](https://explorer-test.qday.info/tx/0x937312aca29d89ad642028088274747b46e63fca885b66ecb0e570e87d1c69e4) | 3768377 | 74581 |
| 10 | STATE: legit invoice while quarantined — pay 0.02 tUSD8 to supplier | agent | QUARANTINED | [0x6e2b58d6…](https://explorer-test.qday.info/tx/0x6e2b58d6fa167ae408456004ab774373828299ba2fc60cc576e9c09252efa58e) | 3768386 | 42036 |
| 11 | STATE: human pardons the agent | owner | ok | [0x66b84302…](https://explorer-test.qday.info/tx/0x66b84302e705bb9f5c6b4efe0f85719e6238d708685204f83659472eee9653d8) | 3768393 | 27665 |
| 12 | ACTS: invoice INV-106 (above review threshold) — pay 0.08 tUSD8 to supplier | agent | HELD_FOR_REVIEW | [0x6482a132…](https://explorer-test.qday.info/tx/0x6482a1323a5e3ec0ddfb22bc313bde1dad7ecff75c1baef8a2677f261fd3bf4e) | 3768397 | 223649 |
| 13 | ACTS: human approves held payment #0 | owner | OK | [0xdf381b17…](https://explorer-test.qday.info/tx/0xdf381b17312154272912042d6c97c28566d586e57d423360e88cc61bad4a0d7e) | 3768401 | 76276 |
| 14 | ESCROW: invoice INV-107 (pay on delivery) — escrow 0.05 tUSD8 to freelancer | agent | OK | [0xbec54efd…](https://explorer-test.qday.info/tx/0xbec54efd7eef10f2078f98f5f41e683d33c344284e8f91340b33c0cb4c354e2a) | 3768406 | 222301 |
| 15 | ESCROW: release with a wrong proof | freelancer | revert BadPreimage | simulated |  |  |
| 16 | ESCROW: refund before the deadline | owner | revert TooEarly | simulated |  |  |
| 17 | ESCROW: freelancer releases with the real proof | freelancer | OK | [0x4b756e98…](https://explorer-test.qday.info/tx/0x4b756e9876d2e3432df19050f61ee8b68fbf9e878199f6866eebfcda87a1a151) | 3768414 | 81863 |
| 18 | ESCROW: invoice INV-108 (90 s deadline) — escrow 0.04 tUSD8 to freelancer | agent | OK | [0xeee3be97…](https://explorer-test.qday.info/tx/0xeee3be97c41c411dd5bbf38581a2908179e79c47191f553fc7dee10d555ca53d) | 3768425 | 205201 |
| 19 | ESCROW: deadline passed, funds return to the vault | owner | OK | [0xb253a561…](https://explorer-test.qday.info/tx/0xb253a56136e5d5aec46d0ae5cd43c3f9d65f7e81f10ca7a93fabde9b4eff3776) | 3768517 | 50118 |
| 20 | STATE: invoice INV-109 (fills the day) — pay 0.06 tUSD8 to supplier | agent | OK | [0xe1d9b8df…](https://explorer-test.qday.info/tx/0xe1d9b8df830117051090cd9841a89a4f8986fc43772347b6e9bd51cbf55c5924) | 3768520 | 85848 |
| 21 | STATE: invoice INV-110 (over the daily cap) — pay 0.06 tUSD8 to supplier | agent | OVER_DAILY_CAP | [0x6f0c6b44…](https://explorer-test.qday.info/tx/0x6f0c6b44f430cab6dc905dc2596b5ac76cd887675cdd55f6e736e995eb21b0d9) | 3768524 | 55031 |
| 22 | THEFT: stolen agent key pays within the rules, fake seal | agent | OK | [0x6a178f36…](https://explorer-test.qday.info/tx/0x6a178f36e32e6c3f151ce7f02e4ab67ee26703359825c61861bf1d8f9c4379d8) | 3768527 | 85848 |
| 23 | SENTINEL: forged seal detected, guardian freezes agent | guardian | FROZEN | [0xa589f7e3…](https://explorer-test.qday.info/tx/0xa589f7e3a8eed13bc89737c1d6e511b429ec36e39137e9bd48c2060f4069d517) | 3768540 |  |
| 24 | SELF: any further agent act after the freeze — pay 0.02 tUSD8 to supplier | agent | REVOKED | [0x39f02467…](https://explorer-test.qday.info/tx/0x39f02467634636254525450588fe74359608766091b27fe2759acf95f28d7e96) | 3768543 | 39666 |

Final: vault holds 0.27 tUSD8 (locked 0.00 tUSD8); 15 acts in the on-chain journal; journal head `0x288f614af463bdc7845facb4522effcd15a428977ba1b0fedb551ebb208fe75f` recomputed by the sentinel from events: **matches**; seal findings: 1 (the stolen-key payment).
Balances after the run: supplier 0.29 tUSD8, freelancer 0.10 tUSD8, attacker 0.00 tUSD8.
