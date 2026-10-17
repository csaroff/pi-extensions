---
"@narumitw/pi-accounts": minor
---

Add automatic rotation: when a request made with a named account hits a usage, quota, or rate limit, the session switches to the provider's next saved account and retries the request. It is on by default, can be turned off from `/accounts`, and never changes the saved default account.
