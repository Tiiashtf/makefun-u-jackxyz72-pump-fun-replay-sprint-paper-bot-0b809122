// Runner Hunter — entrypoint. The strategy lives in strategy.ts; this file only
// wires it to the agent-fun/replay/v2 protocol shim in vendor/.
//
// The bot speaks the protocol on stdin/stdout: a hello message first, then one
// batch per slot, answering each batch with its orders for that slot.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
