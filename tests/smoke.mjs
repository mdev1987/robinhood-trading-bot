import assert from "node:assert/strict";
import { assessConfirmation } from "../src/dexscreener.ts";
import { openPosition, updatePosition } from "../src/position.ts";
import { robinhoodExitProfile } from "../src/config.ts";

assert.equal(assessConfirmation({price:100,liquidityUsd:20000},{price:94,liquidityUsd:20000},5,30).ok,false);
const p=openPosition({id:"smoke",chain:"robinhood",pairAddress:"0x0000000000000000000000000000000000000001",tokenAddress:"0x0000000000000000000000000000000000000002",symbol:"T",tokenName:"T",quoteSymbol:"WETH",dexId:"uniswap",marketPrice:100,usdSize:10,exitProfile:robinhoodExitProfile(),now:1});
const events=updatePosition(p,131,2,{liquidityUsd:20000});
assert(events.some(e=>e.type==='TP'));
assert(events.some(e=>e.type==='TRAIL_ACTIVATED'));
console.log('RH pure smoke: PASS');
