process.env.PHYSICAL_LOG_DISABLE='1';process.env.MENTOR_FAKE_TEXT='1';process.env.MENTOR_FAKE_LIVE='1';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chess-ultra-browser-'));process.env.MENTOR_DB_PATH=path.join(temporary,'test.sqlite');
const {server,mentorFeature,physicalBoardTest:board}=require('../server');
const {loadPlaywright}=require('./playwright-runtime');
let browser;
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await loadPlaywright().chromium.launch({executablePath:String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let behavior='error',calls=[],held=[];
  await page.route('**/api/evaluate?**',route=>route.fulfill({json:{success:true,evaluation:0,bestmove:'bestmove e2e4'}}));
  await page.route('**/api/engine-move',async route=>{const body=route.request().postDataJSON();calls.push(body);
    if(behavior==='hold'){held.push(route);return;}
    if(behavior==='error')return route.fulfill({status:503,json:{success:false,error:'Test engine unavailable'}});
    return route.fulfill({json:{success:true,move:'e2e4',difficultyMode:body.difficultyMode,difficultyLabel:'Ultra',profile:'balanced',selectionStyle:'ultra-stockfish-best'}});
  });
  await page.goto(base);const ultra=page.getByRole('button',{name:'Ultra Mode',exact:true});const level=page.getByLabel('Difficulty level');
  await level.fill('8');await page.waitForFunction(()=>document.querySelector('[aria-label="Difficulty level"]').value==='8');
  await ultra.click();assert.equal(await ultra.getAttribute('aria-pressed'),'true');assert(await level.isDisabled());
  await page.reload();assert.equal(await ultra.getAttribute('aria-pressed'),'true');assert.equal(await level.inputValue(),'8');
  await ultra.click();assert.equal(await level.inputValue(),'8');assert.equal(await level.isDisabled(),false);await ultra.click();
  // Choosing Black starts an engine turn without relying on board drag coordinates.
  const failure=page.waitForResponse(r=>r.url().endsWith('/api/engine-move'));
  await page.getByRole('button',{name:'Black',exact:true}).click();await page.getByRole('button',{name:'New Virtual Game',exact:true}).click();
  await failure;await page.getByRole('button',{name:'Retry engine move'}).waitFor();assert.equal(calls.at(-1).difficultyMode,'ultra');
  assert.equal(await page.locator('[data-square="e2"] [data-piece="wP"]').count(),1);
  assert.equal(await page.locator('[data-square="e4"] [data-piece="wP"]').count(),0);
  behavior='success';await page.getByRole('button',{name:'Retry engine move'}).click();
  await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));
  behavior='hold';await page.getByRole('button',{name:'New Virtual Game',exact:true}).click();
  await page.getByText(/^Ultra is thinking/).waitFor();
  const count=calls.length;await ultra.click();assert.equal(calls.at(-1).difficultyMode,'ultra');assert.equal(calls.length,count);
  await page.getByRole('button',{name:'New Virtual Game',exact:true}).click();
  await page.waitForFunction(()=>localStorage.getItem('chess.ultraMode')==='false');
  // All old responses must be ignored after New Game; the new request uses normal mode.
  for(let n=0;n<100 && !calls.some(c=>c.difficultyMode==='normal');n++) await new Promise(r=>setTimeout(r,10));
  let old=true;
  while(held.length) {const route=held.shift();await route.fulfill({json:{success:true,move:old?'d2d4':'e2e4'}}).catch(()=>{});old=false;}
  assert(calls.some(c=>c.difficultyMode==='normal'));
  await page.locator('[data-square="e4"] [data-piece="wP"]').waitFor();
  assert.equal(await page.locator('[data-square="d2"] [data-piece="wP"]').count(),1);
  // Physical Ultra is session-scoped, preserves normal level, and rejects stale clients.
  behavior='success';board.startPhysicalSession();
  await page.waitForFunction(()=>document.querySelector('button[aria-pressed]')?.disabled===false && document.body.textContent.includes('Physical normal difficulty'));
  assert.equal(await ultra.isDisabled(),false);
  await ultra.click();
  await page.getByText('Physical Ultra: 3 seconds per move. Changes apply next engine turn.',{exact:true}).waitFor();
  assert(await level.isDisabled());assert.equal(board.physicalSession.difficultyMode,'ultra');
  const stale=await fetch(base+'/api/physical/difficulty-mode',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({difficultyMode:'normal',expectedSessionGeneration:-1})});
  assert.equal(stale.status,409);assert.equal(board.physicalSession.difficultyMode,'ultra');
  const invalid=await fetch(base+'/api/physical/difficulty-mode',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({difficultyMode:'invalid'})});assert.equal(invalid.status,400);
  await ultra.click();await page.getByText('Physical normal difficulty. Changes apply next engine turn.',{exact:true}).waitFor();
  assert.equal(await level.isDisabled(),false);assert.equal(await level.inputValue(),'8');
  await page.goto(base+'/mentor');assert.equal(await page.getByRole('button',{name:'Ultra Mode',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  await context.close();console.log('Ultra browser: persistence, previous level, retry, next-turn mode, cancellation and physical/Mentor isolation passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();await mentorFeature.close();server.closeAllConnections();await new Promise(r=>server.listening?server.close(r):r());fs.rmSync(temporary,{recursive:true,force:true});});
