# VAULTBORN Chipnet verification

> **Historical record.** This file documents an earlier run under earlier prices, splits and contracts (before the final economy of 19 November 2026). It is kept as evidence of that run only. Current rules: [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md).

The published evidence below comes from public Bitcoin Cash Chipnet. Testers used disposable keys with pre-funded Chipnet BCH and a separate local game database. The running save was preserved. Both the incoming observer and the operator payout path required two confirmations.

| Action | Satoshis | Wallet or settlement fee | Confirmations at recording | Receipt |
| --- | ---: | ---: | ---: | --- |
| Protocol-only split and burn | 4,500 | 366 | 2 | [d494e0c2…c8d5](https://chipnet.imaginary.cash/tx/d494e0c2f746dbd7553770ffcf6f8d7c6bda88284473620aed866b2360e0c8d5) |
| City Hall premium upgrade | 4,500 | 366 | 3 | [bcca3285…aca8](https://chipnet.imaginary.cash/tx/bcca3285cbdaa2c2df2ed6349b6cc5b89040d90b9394f88000e4da2ec19daca8) |
| Paid raid initiation | 6,000 | 366 | 3 | [e9055762…0525](https://chipnet.imaginary.cash/tx/e9055762cb16374227d23cadddf96011b13b6841c309ea85f1e807bba2e40525) |
| Battle escrow settlement | 3,000 escrow | 516 | 5 | [121d6043…5797](https://chipnet.imaginary.cash/tx/121d6043929391405bb589aaf1aca3b2ad5b628012734e9e1940e55316365797) |
| Direct seasonal sponsorship | 8,000 | 302 | 3 | [084a5528…9bb3](https://chipnet.imaginary.cash/tx/084a5528f775499a08453f131e4e2221c75714e1378f0c8ba9a0be86403a9bb3) |
| Funded season prize claim | 3,255 | 356 | 2 | [491597a3…673f](https://chipnet.imaginary.cash/tx/491597a3e95b6c9fff694ea5527abcbf4fac10b60e3da1705dfb05a99508673f) |
| Browser WizardConnect premium upgrade | 4,500 | 366 | 2 | [432d2281…3895](https://chipnet.imaginary.cash/tx/432d2281bdba1d845dfe36b49476c8fad5db4efbac7dff85c27c1bb6ca653895) |

The premium payment funded 2,250 sats for the kingdom, 900 for development, 675 for prizes and 675 in a value-bearing OP_RETURN. The raid funded 3,000 sats for escrow, 1,200 for development, 900 for prizes and burned 900. In block 334230 the battle settlement spent its exact raid escrow and development outputs, moved all 3,000 escrow sats to a new reserve, and returned 684 sats to development after the 516-sat fee. Its OP_RETURN at output 2 commits to the preserved full battle record. No TXIDs were typed into the running game. The observer discovered the incoming transactions through their payment outputs.

The campaign clock was moved forward only inside the isolated test to finalize standings and exercise a sponsored claim. A withdrawal without consent and a repeated claim were rejected. The real raid used a seeded opponent with no opted-in BCH balance. The two verified kingdoms capture and defense rules were covered by controlled ledger tests and the economic simulation. The independently replayed battle result, recorded block hashes and all allocation amounts are available in the JSON evidence.

- [Full transaction receipts](VAULTBORN_CHIPNET_RECEIPTS.json)
- [Verifiable battle archive](VAULTBORN_VERIFIABLE_BATTLE.json)

The public Riften relay attempt from this environment timed out opening its WebSocket. The browser then used the official WizardConnect dapp and wallet SDKs over a temporary loopback relay. The independent wallet fixture approved the full outputs and fee, returned a valid signature, and the browser sent it to the verifier. The server derived the TXID and broadcast it to public Chipnet. The settled transaction in block 334369 fulfilled City Hall’s upgrade. The fixture reported a WebSocket error during teardown after saving the receipt. A subsequent pairing-only run verified the corrected disconnect sequence. Commercial wallet applications still need interoperability testing. [WizardConnect evidence](VAULTBORN_WIZARD_RECEIPT.json)

```sh
node scripts/verify-battle.mjs docs/VAULTBORN_VERIFIABLE_BATTLE.json --chipnet
```

The earlier BCH Dominion receipts include the historical rush, protectorate, deposits, withdrawals and badge mint. Those payments precede split checkout. No Regtest node, Mainnet payment, or new CashToken transfer was used in these tests. [Historical verification](CHIPNET_VERIFICATION_REPORT.md)
