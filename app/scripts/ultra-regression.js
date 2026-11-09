process.env.PHYSICAL_LOG_DISABLE = '1';
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Chess } = require('chess.js');
const { SpotifyRelayService } = require('../audio/spotify-relay-service');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-ultra-'));
process.env.MENTOR_DB_PATH = path.join(temporary, 'test.sqlite');
const { MentorEngineService } = require('../mentor/engine-service');
const { server, mentorFeature, gameEngine, chooseEngineMove } = require('../server');
const START = new Chess().fen();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let n=0;n<200;n++) {if(fn())return; await sleep(5);}throw Error('Timeout'); }
class Fake extends EventEmitter {
  constructor(){super();this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.commands=[];
    this.stdin={writable:true,write:value=>this.command(value.trim())};}
  line(line){queueMicrotask(()=>this.stdout.emit('data',Buffer.from(line+'\n')));}
  command(value){this.commands.push(value);if(value==='uci')this.line('uciok');if(value==='isready')this.line('readyok');if(value==='stop')this.complete();}
  complete(){this.line('info depth 16 score cp 25 nodes 1234 nps 50000 time 3000 pv e2e4 e7e5');this.line('bestmove e2e4');}
  kill(){this.stdin.writable=false;queueMicrotask(()=>this.emit('exit',0));}
}
async function workerChecks(){
  const fake=new Fake();const engine=new MentorEngineService({processFactory:()=>fake,maxWaitingJobs:2,threads:4,hashMb:256});
  const background=engine.analyzeFen(START,{movetimeMs:500,priority:'evaluation'}).catch(e=>e);
  await until(()=>fake.commands.includes('go movetime 500'));
  const ultra=engine.analyzeFen(START,{movetimeMs:3000,multiPv:1,priority:'move'});
  assert.equal((await background).name,'AbortError');
  await until(()=>fake.commands.includes('go movetime 3000'));
  assert(fake.commands.includes('setoption name Threads value 4'));
  assert(fake.commands.includes('setoption name Hash value 256'));
  assert(fake.commands.includes('setoption name Skill Level value 20'));
  assert(fake.commands.includes('setoption name UCI_LimitStrength value false'));
  fake.complete();await ultra;
  const controller=new AbortController();const first=engine.analyzeFen(START,{depth:15,priority:'move',signal:controller.signal}).catch(e=>e);
  await until(()=>fake.commands.includes('go depth 15'));
  const pending1=engine.analyzeFen(START,{depth:1,priority:'move'});
  const pending2=engine.analyzeFen(START,{depth:2,priority:'move'});
  await assert.rejects(engine.analyzeFen(START,{priority:'move'}),{code:'engine_busy'});
  controller.abort();assert.equal((await first).name,'AbortError');
  await until(()=>fake.commands.includes('go depth 1'));fake.complete();await pending1;
  await until(()=>fake.commands.includes('go depth 2'));fake.complete();await pending2;
  const oldCount=fake.commands.length;
  assert.equal((await engine.analyzeFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).status,'terminal');
  assert.equal(fake.commands.length,oldCount);
  engine.close();
  const wrong = new MentorEngineService({processFactory:()=>new Fake(),validateIdentity:true});
  await assert.rejects(wrong.ensureProcess(),{code:'engine_setup'});wrong.close();
  const missing = new MentorEngineService({stockfishPath:path.join(temporary,'missing.exe')});
  await assert.rejects(missing.ensureProcess(),/setup-stockfish/);missing.close();
}
async function main(){
  await workerChecks();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async body=>{const r=await fetch(base+'/api/engine-move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  assert.equal((await request({fen:START,difficultyMode:'bogus'})).status,400);
  assert.equal((await request({fen:'invalid',difficultyMode:'ultra'})).status,400);
  assert.equal((await request({fen:'7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',difficultyMode:'ultra'})).status,400);
  await gameEngine.ensureProcess();assert.match(gameEngine.identity,/^Stockfish 19\b/);
  const positions=[START,'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'];
  const benchmark=[];
  for(const fen of positions){const started=Date.now();const r=await request({fen,difficultyMode:'ultra',profile:'chaotic',level:1});
    assert.equal(r.status,200);assert.equal(r.body.selectionStyle,'ultra-stockfish-best');assert.equal(r.body.difficultyMode,'ultra');
    assert(new Chess(fen).move({from:r.body.move.slice(0,2),to:r.body.move.slice(2,4),promotion:r.body.move[4]}));
    assert(r.body.telemetry.timeMs>=2700);assert(r.body.telemetry.timeMs<4500);
    benchmark.push({fen,move:r.body.move,telemetry:r.body.telemetry,totalMs:Date.now()-started});}
  for(const level of [1,2,3,6,9,12,15]) {const r=await request({fen:START,level});assert.equal(r.status,200);assert.equal(r.body.difficultyMode,'normal');assert(new Chess(START).move({from:r.body.move.slice(0,2),to:r.body.move.slice(2,4),promotion:r.body.move[4]}));}
  const promotion=await request({fen:'7k/P7/8/8/8/8/8/7K w - - 0 1',difficultyMode:'ultra'});assert.equal(promotion.status,200);assert(new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1').move({from:promotion.body.move.slice(0,2),to:promotion.body.move.slice(2,4),promotion:promotion.body.move[4]}));
  const nativeNormal=[];for(const fen of positions){const started=Date.now();const result=await chooseEngineMove(fen,15,'balanced');nativeNormal.push({fen,...result,totalMs:Date.now()-started});}
  const abort=new AbortController();const cancelled=gameEngine.analyzeFen(START,{movetimeMs:3000,priority:'move',signal:abort.signal}).catch(e=>e);
  await sleep(100);abort.abort();assert.equal((await cancelled).name,'AbortError');
  const httpAbort=new AbortController();
  const disconnected=fetch(base+'/api/engine-move',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({fen:START,difficultyMode:'ultra'}),signal:httpAbort.signal});
  await sleep(100);httpAbort.abort();await assert.rejects(disconnected,/abort/i);
  await until(()=>!gameEngine.currentJob);
  const recovered=await gameEngine.analyzeFen(START,{depth:2,priority:'move',multiPv:1});assert(recovered.bestMove.uci);
  const concurrent=await Promise.all([gameEngine.analyzeFen(START,{movetimeMs:3000,priority:'move',multiPv:1}),mentorFeature.engineService.analyzeFen(START,{movetimeMs:1000})]);
  assert(concurrent[0].telemetry.timeMs>=2700);assert.notEqual(gameEngine.process.pid,mentorFeature.engineService.process.pid);
  // Real local music encoding/mixing workload, with no account or physical-board interaction.
  const relay=new SpotifyRelayService({port:0,token:'benchmark-only',librespotPath:process.execPath,cacheDir:path.join(temporary,'relay'),logger:{log(){},warn(){},error(){}}});
  relay.startLibrespot=()=>{};
  const pcm=Buffer.alloc(3528);
  for(let i=0;i<882;i++){const value=Math.round(2000*Math.sin(2*Math.PI*440*i/44100));pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}
  let feed,underMusic;
  try {
    await relay.enable();feed=setInterval(()=>{if(relay.musicQueue.length<3528*8)relay.musicQueue.push(pcm);},20);
    await sleep(500);
    const started=Date.now();
    const musicResult=await Promise.all([gameEngine.analyzeFen(START,{movetimeMs:3000,priority:'move',multiPv:1}),mentorFeature.engineService.analyzeFen(START,{movetimeMs:1000})]);
    underMusic={totalMs:Date.now()-started,telemetry:musicResult.map(r=>r.telemetry)};
    assert(musicResult[0].telemetry.timeMs>=2700 && musicResult[0].telemetry.timeMs<4500);
    assert(relay.rollingBytes>0,'Music pipeline must actually produce MP3');
  } finally {clearInterval(feed);await relay.close();}
  const logs=path.resolve(__dirname,'../../logs');fs.mkdirSync(logs,{recursive:true});fs.writeFileSync(path.join(logs,'stockfish-19-benchmark.json'),JSON.stringify({benchmark,nativeNormal,underMusic,concurrent:concurrent.map(r=>r.telemetry)},null,2));
  console.log('Ultra/native 19: command policy, priority, queue bounds, cancellation, normal levels, legal moves, terminal positions, native timing and Mentor concurrency passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await mentorFeature.close();server.closeAllConnections();await new Promise(r=>server.listening?server.close(r):r());fs.rmSync(temporary,{recursive:true,force:true});});
