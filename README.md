# objktArchive

Single-file local utility for comparing objkt.com created/owned items against a Sup/p2fk keyword and optionally etching missing IPFS references with the SupSpace-style testnet3 wallet flow.

Mempool requests share a per-page queue: up to 10 attempts start in a burst, followed by a 10-second pause. HTTP 429 pauses the queue for at least 10 seconds, or longer when `Retry-After` requests it. With the default `https://mempool.space/testnet/api`, unavailable or timed-out endpoints roll over to 47 regional Mempool nodes using Testnet3; subsequent requests prefer the working node. A custom Mempool API is used on its own, without switching networks or providers automatically.
