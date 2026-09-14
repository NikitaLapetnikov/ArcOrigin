# Zero launch fee

Status: executed and verified on 2026-09-14. The owner Safe executed
`setLaunchFee(0)` at block 20,788,069, reducing the fee from 1 USDC to 0.
Transaction: `0xb9774da403743efc8e89da08ce53a1bfc19b1df0ead7ac9cb6e0ecda5a6a26d6`.
The receipt succeeded, the Factory emitted its fee-change event from
1,000,000 base units to 0, and a subsequent `launchFee()` read returned 0.
Safe nonce: 10. Do not submit the completed batch again.

## Governance execution procedure (completed)

1. Open the Arc Safe `0xa6eA2380F98700AD5CA8B9F74dC8861269513779` on chain 5042.
2. In Transaction Builder, import `arc-mainnet-launch-fee-zero.safe.json`.
3. Review the single call: Factory `0xF41ee2BC71fC0AB47A56Abb078E53a02A9B39899`,
   `setLaunchFee(0)`, native value 0, operation CALL.
4. Obtain the required owner signatures and execute in Safe.
5. Confirm the execution receipt succeeded and read `launchFee()` from the
   active Factory. It must return 0 before announcing free launches.

Trading fees, creator fee routing, buybacks, and network gas are unchanged.
Gas and an optional initial purchase are still paid by the creator.

The launch form reads the fee from the Factory, refreshes it every 30 seconds,
and verifies it again before metadata publication or transaction submission.
It skips the USDC allowance read and approval when the verified fee is zero.
An unavailable fee read never substitutes a hardcoded fee.
