---
"@narumitw/pi-goal": patch
---

Allow `/goal resume` on idle restored active Goals and add Ask, Auto, and Off restore modes, with Ask as the default. Restore pause uses the normal abort and stale-tool protections, and explicit waiting resume clears the wait. Reject active resume while owned prompts or host messages are pending, preserve ownership after failed active resume, recover unacknowledged restore startup with a 30-second idle pause, and await restored Goal settlement in print and JSON hosts. Cancel restore dialogs and startup waits on session shutdown or replacement. Recover unacknowledged idle-active manual resume by restoring the original Goal, abort late cancelled startup prompts before live provider work, exclude JSON SDK dialogs even with a UI, and dispatch already-due Auto wait deadlines before headless shutdown.
