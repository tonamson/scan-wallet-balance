# Remove Completed Wallet Files

`collect.js` removes each source wallet JSON after `collectWallet()` returns successfully. A zero token or zero BNB balance is a successful skipped transfer and therefore still removes the file. Any thrown error, including a failed transaction receipt, leaves the file in place for retry.
