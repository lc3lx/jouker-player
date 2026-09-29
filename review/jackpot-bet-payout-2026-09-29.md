# Jackpot payouts by triggering bet

User-approved payouts: SUPER 100x, MEGA 500x, GRAND 1000x the base bet.
At a 100,000 bet the prizes remain 10M / 50M / 100M. At 10,000 they are
1M / 5M / 10M. This deliberately changes the jackpot contribution at other
stakes; it is not a claim that the overall RTP is unchanged.

Zeus, Poseidon, Zenobia and Golden Tree pass their validated base bet to the
shared round creator. Bonus spins use the locked bonus bet, not a zero debit or
the bonus purchase price. Zeus double-chance fees do not increase the base bet.
Trigger probabilities, nine-card layout and first-triple selection are unchanged.

New rounds snapshot betAmount, payoutVersion=2 and each card's monetary award.
Recovery and settlement use stored awards, never a later client bet. Legacy
rounds require no migration and retain their stored prizes. Existing tier IDs
remain unchanged for API compatibility. Public tierAmounts contains only tier
totals, never the hidden card positions.

Settlement now serializes requests per player and writes the wallet credit and
settled round marker in the same Mongo transaction. Production already requires
Mongo transactions through walletLedgerService. Jackpot settlement also refuses
the non-transaction development fallback; standalone development databases must
use a replica set or the stub test mode. Zenobia repeat settlement now reads the
correct wallet adapter in stub mode.

Client: reusable transparent plaques display current-bet estimates in all four
game headers and server amounts on revealed cards and the win overlay. Exact
amounts are grouped with commas. Rules no longer advertise fixed awards. Card
reveal taps are serialized while a response is pending.

Validation:
- 55 Node tests passed (poseidonJackpot, kingArthJackpot, jackpotBetPayout).
- 3 Flutter tests passed (jackpot_dynamic_prize_test).
- Tests cover all four games, three stakes and three tiers, recovery, hidden
  positions, legacy awards, invalid amounts and concurrent repeat settlement.
- Render inspected: frontapp/build/previews/jackpot-dynamic-plaques.png.
- No live Mongo transaction integration run, Android device run or deployment
  was performed. Ship backend and client together: an old client has fixed
  numbers in its existing artwork even though it receives the correct award.
