Shipped a small change to the site today that I'd been meaning to do for a while: the P&L charts now have a **max** view.

Until today they only went back a year, and not by choice. The numbers here come from IBKR's Flex Query, which only ever hands back a trailing ~365 days. Every daily refresh quietly drops the oldest day off the back, so no matter how long I run this, the chart could never show more than a year, and any note I'd pinned to the curve older than that would eventually fall off the left edge with it.

So now the site keeps its own memory. Each refresh stitches the latest snapshot into a history file that only grows, instead of leaning on whatever window IBKR feels like returning. The benchmarks accumulate the same way, so the risk stats (vol, drawdown, beta) hold up over the long view too.

I'd assumed the memory would have to start *today*, with everything before it still capped at the one year IBKR gave me, and that max wouldn't mean anything for a few quarters. That turned out to be wrong. Every daily `portfolio: refresh` commit in the repo had already saved its own trailing-year snapshot, and the older the commit, the further back its window reached. Replaying them oldest-first through the same merge the daily job uses reconstructs the history as if I'd been keeping it from the start.

So max already goes back to 24 April 2025, about fifteen months and 327 trading days, rather than the trailing year. Put another way, the charts now remember a full year before the site itself existed: the oldest snapshot I ever committed was the day I launched this thing, and it arrived carrying IBKR's trailing year with it. From here it only grows forward.
