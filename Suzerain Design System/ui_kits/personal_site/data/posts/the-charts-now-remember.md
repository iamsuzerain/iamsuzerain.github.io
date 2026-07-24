Shipped a small change to the site today that I'd been meaning to do for a while: the P&L charts now have a **max** view.

Until today they only went back a year, and not by choice. The numbers here come from IBKR's Flex Query, which only ever hands back a trailing ~365 days. Every daily refresh quietly drops the oldest day off the back, so no matter how long I run this, the chart could never show more than a year — and any note I'd pinned to the curve older than that would eventually fall off the left edge with it.

So now the site keeps its own memory. Each refresh stitches the latest snapshot into a history file that only grows, instead of leaning on whatever window IBKR feels like returning. The benchmarks accumulate the same way, so the risk stats — vol, drawdown, beta — hold up over the long view too.

The honest caveat: the memory starts *today*. Everything before this is still just the one year IBKR gave me; everything from here forward is mine to keep. Give it a few quarters and the max view will actually mean something.
