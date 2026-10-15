---
"@narumitw/pi-accounts": minor
---

Add opt-in automatic rotation: when a request made with a named account hits a usage, quota, or rate limit, the session switches to the provider's next saved account and retries the request. Toggle it from `/accounts`; it is off by default and never changes the saved default account.
