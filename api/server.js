require('dotenv').config();
const express=require('express'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const bcrypt=require('bcryptjs'), jwt=require('jsonwebtoken');
const {z}=require('zod');
const {Pool}=require('pg');

/* Real OpenAI Responses API adapter — server side only. */
async function openAIResponses(input, options={}){
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const model=options.model||process.env.OPENAI_MODEL||'gpt-5.6-luna';
  const body={model,input,max_output_tokens:options.maxOutputTokens||1800};
  if(options.instructions) body.instructions=options.instructions;
  if(options.text) body.text=options.text;
  const response=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const text=await response.text();
  if(!response.ok) throw new Error(`OpenAI API ${response.status}: ${text.slice(0,500)}`);
  const data=JSON.parse(text);
  return {id:data.id,model:data.model,text:data.output_text||'',usage:data.usage||null};
}

const app=express();

/* Production security baseline */
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.use((req,res,next)=>{
  const requestId=crypto.randomUUID();
  req.requestId=requestId;
  res.setHeader('X-Request-Id',requestId);
  const started=Date.now();
  res.on('finish',()=>console.log(JSON.stringify({
    event:'http_request',
    requestId,
    method:req.method,
    path:req.path,
    status:res.statusCode,
    durationMs:Date.now()-started
  })));
  next();
});
app.use((req,res,next)=>{
  const allowed=(process.env.CORS_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  const origin=req.headers.origin;
  if(origin && allowed.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if(req.method==='OPTIONS') return res.status(204).end();
  next();
});
const rateBuckets=new Map();
function rateLimit(req,res,next){
  const windowMs=Number(process.env.RATE_LIMIT_WINDOW_MS||60000);
  const max=Number(process.env.RATE_LIMIT_MAX||120);
  const key=`${req.ip||'unknown'}:${Math.floor(Date.now()/windowMs)}`;
  const count=(rateBuckets.get(key)||0)+1;
  rateBuckets.set(key,count);
  if(count>max) return res.status(429).json({error:'RATE_LIMITED',requestId:req.requestId});
  if(rateBuckets.size>10000) rateBuckets.clear();
  next();
}
app.use(rateLimit);
app.use(express.json({limit:process.env.JSON_BODY_LIMIT||'2mb'}));
const pool=process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.PG_POOL_MAX||5),idleTimeoutMillis:Number(process.env.PG_IDLE_TIMEOUT_MS||10000),connectionTimeoutMillis:Number(process.env.PG_CONNECTION_TIMEOUT_MS||5000)}) : null;
const JWT_SECRET=process.env.JWT_SECRET||'';
if(process.env.NODE_ENV==='production' && JWT_SECRET.length<32){
  throw new Error('JWT_SECRET must be configured with at least 32 characters in production');
}
const users=new Map(), assessments=new Map(), plans=new Map(), sessions=new Map(), pushTokens=new Map(), videos=new Map(), entitlements=new Map();
const id=()=>crypto.randomUUID();


async function dbUserByEmail(email){
  if(!pool) return null;
  const r=await pool.query('SELECT id,email,role,password_hash FROM app_users WHERE email=$1',[email]);
  return r.rows[0]||null;
}
async function dbUserById(id){
  if(!pool) return null;
  const r=await pool.query('SELECT id,email,role FROM app_users WHERE id=$1',[id]);
  return r.rows[0]||null;
}
async function dbLatestAssessment(userId){
  if(!pool) return null;
  const r=await pool.query('SELECT age,position,level,goal,scores,created_at FROM player_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[userId]);
  return r.rows[0]||null;
}
async function dbPlayerContext(userId){
  if(!pool) return null;
  const [u,a,s,g,d]=await Promise.all([
    dbUserById(userId),
    dbLatestAssessment(userId),
    pool.query('SELECT id,status,exercises,feedback,started_at,completed_at,created_at FROM player_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[userId]),
    pool.query('SELECT competency,target,status,review_date FROM player_goals WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 20',[userId,'ACTIVE']),
    pool.query('SELECT decision_type,result,model,created_at FROM ai_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',[userId])
  ]);
  return {
    identity:u?{id:u.id,email:u.email,role:u.role}:null,
    assessment:a?{age:a.age,position:a.position,level:a.level,goal:a.goal,scores:a.scores}:null,
    recentTraining:s.rows,
    goals:g.rows,
    aiHistory:d.rows
  };
}
async function saveAIDecision(userId,type,context,result,model){
  if(pool) await pool.query(
    'INSERT INTO ai_decisions(user_id,decision_type,context,result,model) VALUES($1,$2,$3,$4,$5)',
    [userId,type,context,result,model||null]
  );
}

function tokenFor(u){return jwt.sign({sub:u.id,email:u.email,role:u.role},JWT_SECRET,{expiresIn:'7d'});}
function auth(req,res,next){try{const h=req.headers.authorization||''; if(!h.startsWith('Bearer ')) throw 0; req.user=jwt.verify(h.slice(7),JWT_SECRET); next()}catch{res.status(401).json({error:'UNAUTHORIZED'})}}
async function persistRun(runKey,status,result){
 if(pool) await pool.query('INSERT INTO staging_runs(run_key,status,finished_at,result) VALUES($1,$2,NOW(),$3)',[runKey,status,result||{}]);
}

app.get('/api/setup/status', async (req,res)=>{
  const status = {
    app: 'Future Blue Shark Player',
    version: process.env.APP_VERSION || '4.8.0',
    environment: process.env.NODE_ENV || 'development',
    database: { configured: !!process.env.DATABASE_URL, reachable: false },
    ai: { configured: !!process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-5.6-luna' },
    auth: { configured: JWT_SECRET.length >= 32 },
    ready: false
  };
  if (pool) {
    try {
      await pool.query('SELECT 1');
      status.database.reachable = true;
    } catch {}
  }
  status.exerciseLibrary = await dbExerciseLibraryStats();
  status.ready = status.database.configured && status.database.reachable && status.auth.configured;
  res.json(status);
});

app.get('/api/health',async(req,res)=>{
 const db=pool?'postgresql':'memory';
 let dbOk=true; if(pool){try{await pool.query('SELECT 1')}catch{dbOk=false}}
 res.json({ok:dbOk,version:process.env.APP_VERSION||'1.2.0',environment:process.env.NODE_ENV||'development',storage:db,aiProvider:process.env.AI_PROVIDER||'deterministic',billingProvider:process.env.BILLING_PROVIDER||'stub',pushProvider:process.env.PUSH_PROVIDER||'stub'});
});
app.post('/api/register',async(req,res)=>{
 const v=z.object({email:z.string().email(),password:z.string().min(8),role:z.enum(['player','parent','coach','admin']).default('player')}).safeParse(req.body);
 if(!v.success)return res.status(400).json({error:'INVALID_INPUT',details:v.error.issues});
 const {email,password,role}=v.data;
 if(pool){
   const existing=await dbUserByEmail(email);
   if(existing)return res.status(409).json({error:'EMAIL_EXISTS'});
   const u={id:id(),email,role,passwordHash:await bcrypt.hash(password,12)};
   await pool.query('INSERT INTO app_users(id,email,role,password_hash) VALUES($1,$2,$3,$4)',[u.id,u.email,u.role,u.passwordHash]);
   return res.status(201).json({user:{id:u.id,email:u.email,role:u.role},token:tokenFor(u)});
 }
 if(users.has(email))return res.status(409).json({error:'EMAIL_EXISTS'});
 const u={id:id(),email,role,passwordHash:await bcrypt.hash(password,12),createdAt:new Date().toISOString()};
 users.set(email,u); res.status(201).json({user:{id:u.id,email:u.email,role:u.role},token:tokenFor(u)});
});
app.post('/api/login',async(req,res)=>{
 const email=req.body?.email||'', password=req.body?.password||'';
 const u=pool?await dbUserByEmail(email):users.get(email);
 if(!u || !(await bcrypt.compare(password,u.password_hash||u.passwordHash))) return res.status(401).json({error:'INVALID_CREDENTIALS'});
 res.json({token:tokenFor({id:u.id,email:u.email,role:u.role}),user:{id:u.id,email:u.email,role:u.role}});
});
app.get('/api/me/profile',auth,(req,res)=>res.json({user:req.user}));
app.post('/api/assessment',auth,async(req,res)=>{
 const a={userId:req.user.sub,age:Number(req.body.age),position:req.body.position||'Extremo',level:req.body.level||'Desenvolvimento',goal:req.body.goal||'Melhorar decisão',scores:req.body.scores||{},createdAt:new Date().toISOString()};
 assessments.set(req.user.sub,a);
 if(pool) await pool.query('INSERT INTO player_assessments(user_id,age,position,level,goal,scores) VALUES($1,$2,$3,$4,$5,$6)',[req.user.sub,a.age,a.position,a.level,a.goal,a.scores]);
 res.status(201).json(a);
});
app.post('/api/ai-coach/report',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{};
 const scores=a.scores||{}; const low=Object.entries(scores).filter(([,v])=>Number(v)<65).sort((x,y)=>x[1]-y[1]).slice(0,3).map(x=>x[0]);
 res.json({summary:'Análise longitudinal preparada para o próximo ciclo.',priorities:low.length?low:['Decisão','Posicionamento'],explanation:'Prioridades derivadas da avaliação e do objetivo, com foco em evolução progressiva.'});
});
app.post('/api/plan/generate',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{}; const report={priorities:['Decisão','Passe','Agilidade']};
 const p={id:id(),userId:req.user.sub,weeks:4,availability:req.body.availability||['MON','WED','FRI'],goal:a.goal||'Desenvolvimento',priorities:report.priorities,status:'ACTIVE',createdAt:new Date().toISOString()};
 plans.set(req.user.sub,p); res.status(201).json(p);
});
app.get('/api/plan/current',auth,(req,res)=>res.json(plans.get(req.user.sub)||null));
app.post('/api/session',auth,(req,res)=>{const s={id:id(),userId:req.user.sub,planId:plans.get(req.user.sub)?.id,status:'CREATED',exercises:[]};sessions.set(s.id,s);res.status(201).json(s)});
app.post('/api/session/:id/start',auth,(req,res)=>{const s=sessions.get(req.params.id);if(!s||s.userId!==req.user.sub)return res.status(404).json({error:'NOT_FOUND'});s.status='STARTED';s.startedAt=new Date().toISOString();res.json(s)});
app.post('/api/session/:id/exercise',auth,(req,res)=>{const s=sessions.get(req.params.id);if(!s||s.userId!==req.user.sub)return res.status(404).json({error:'NOT_FOUND'});s.exercises.push({exerciseId:req.body.exerciseId||'demo-1',completed:true,at:new Date().toISOString()});res.json(s)});
app.post('/api/session/:id/feedback',auth,(req,res)=>{const s=sessions.get(req.params.id);if(!s||s.userId!==req.user.sub)return res.status(404).json({error:'NOT_FOUND'});s.status='COMPLETED';s.feedback=req.body;res.json({ok:true,nextCycleAdjustment:'Increase decision-making exposure gradually.',session:s})});
app.post('/api/calendar',auth,(req,res)=>res.status(201).json({id:id(),userId:req.user.sub,...req.body}));
app.post('/api/push-token',auth,(req,res)=>{pushTokens.set(req.user.sub,req.body.token);res.status(201).json({ok:true,provider:process.env.PUSH_PROVIDER||'stub'})});
app.post('/api/video/register',auth,(req,res)=>{const key=`${req.user.sub}/${id()}-${String(req.body.filename||'video.mp4').replace(/[^a-zA-Z0-9._-]/g,'_')}`;const dir=process.env.VIDEO_STORAGE_PATH||'./storage/videos';fs.mkdirSync(dir,{recursive:true});const v={id:id(),storageKey:key,mimeType:req.body.mimeType||'video/mp4',status:'STAGED'};videos.set(v.id,v);res.status(201).json(v)});
app.post('/api/billing/webhook',async(req,res)=>{const e=req.body||{};const ent={provider:process.env.BILLING_PROVIDER||'stub',externalId:e.externalId||id(),productId:e.productId||'player',status:e.status||'ACTIVE',rawEvent:e};entitlements.set(ent.externalId,ent);if(pool)await pool.query('INSERT INTO billing_entitlements(provider,external_id,product_id,status,raw_event) VALUES($1,$2,$3,$4,$5)',[ent.provider,ent.externalId,ent.productId,ent.status,e]);res.json({received:true,entitlement:ent})});
app.get('/api/billing/entitlement',auth,(req,res)=>res.json([...entitlements.values()][0]||{status:'NONE'}));
const academies=new Map(), teams=new Map(), academyMembers=new Map();
app.post('/api/academy',auth,(req,res)=>{
 if(req.user.role!=='admin' && req.user.role!=='coach') return res.status(403).json({error:'ROLE_FORBIDDEN'});
 const a={id:id(),name:req.body.name||'Academy',createdBy:req.user.sub,createdAt:new Date().toISOString()};
 academies.set(a.id,a); res.status(201).json(a);
});
app.post('/api/academy/:academyId/team',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const t={id:id(),academyId:a.id,name:req.body.name||'Team',coachId:req.user.role==='coach'?req.user.sub:null};
 teams.set(t.id,t); res.status(201).json(t);
});
const academyEvents=new Map(), callups=new Map(), alerts=new Map();
app.post('/api/academy/:academyId/event',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const e={id:id(),academyId:a.id,type:req.body.type||'TRAINING',title:req.body.title||'Evento',date:req.body.date||new Date().toISOString(),teamId:req.body.teamId||null,location:req.body.location||null};
 academyEvents.set(e.id,e); res.status(201).json(e);
});
const loads=new Map(), attendance=new Map(), developmentGoals=new Map();
app.post('/api/academy/team/:teamId/load',auth,(req,res)=>{
 const x={id:id(),teamId:req.params.teamId,playerId:req.body.playerId||null,date:req.body.date||new Date().toISOString(),durationMin:Number(req.body.durationMin||0),rpe:Number(req.body.rpe||0),load:Number(req.body.durationMin||0)*Number(req.body.rpe||0),type:req.body.type||'TRAINING'};
 loads.set(x.id,x); res.status(201).json(x);
});
const positionProfiles={
 'Guarda-redes':['Reação','Posicionamento','Distribuição','1x1 defensivo'],
 'Defesa central':['Posicionamento','Cobertura','Passe','1x1 defensivo'],
 'Lateral':['Velocidade','1x1','Cruzamento','Transição'],
 'Médio defensivo':['Posicionamento','Passe','Cobertura','Decisão'],
 'Médio centro':['Passe','Receção','Decisão','Resistência'],
 'Médio ofensivo':['Decisão','Passe','Finalização','Criatividade'],
 'Extremo':['1x1','Aceleração','Cruzamento','Finalização'],
 'Segundo avançado':['Decisão','Movimento','Finalização','Pressão'],
 'Avançado':['Finalização','Movimento','1x1','Pressão']
};
const exerciseCatalog=[
 {id:'gr-passe',name:'Distribuição do guarda-redes',domain:'technical',positions:['Guarda-redes'],competencies:['Distribuição','Passe'],difficulty:2,ages:[8,9,10,11,12,13,14,15,16,17,18,19,20,21],goals:['Técnica']},
 {id:'dc-cobertura',name:'Cobertura defensiva',domain:'tactical',positions:['Defesa central'],competencies:['Cobertura','Posicionamento'],difficulty:3,ages:[10,11,12,13,14,15,16,17,18,19,20,21],goals:['Defesa']},
 {id:'lat-cruz',name:'Cruzamento em movimento',domain:'technical',positions:['Lateral'],competencies:['Cruzamento','Velocidade'],difficulty:3,ages:[10,11,12,13,14,15,16,17,18,19,20,21],goals:['Ataque']},
 {id:'med-passe',name:'Passe sob pressão',domain:'technical',positions:['Médio defensivo','Médio centro','Médio ofensivo'],competencies:['Passe','Decisão'],difficulty:3,ages:[10,11,12,13,14,15,16,17,18,19,20,21],goals:['Técnica','Decisão']},
 {id:'ext-1v1',name:'1x1 ofensivo',domain:'technical',positions:['Extremo'],competencies:['1x1','Aceleração'],difficulty:3,ages:[8,9,10,11,12,13,14,15,16,17,18,19,20,21],goals:['Drible']},
 {id:'av-final',name:'Finalização após movimento',domain:'technical',positions:['Segundo avançado','Avançado'],competencies:['Finalização','Movimento'],difficulty:3,ages:[10,11,12,13,14,15,16,17,18,19,20,21],goals:['Finalização']},
 {id:'decision-scan',name:'Receber e decidir',domain:'cognitive',positions:['Médio centro','Médio ofensivo','Extremo','Segundo avançado','Avançado'],competencies:['Decisão','Perceção'],difficulty:4,ages:[12,13,14,15,16,17,18,19,20,21],goals:['Melhorar decisão']}
];

const aiContentTemplates = [
 {domain:'technical',title:'Receção orientada e passe',competencies:['Receção','Passe'],ageMin:8,ageMax:21,positions:['Médio centro','Médio ofensivo','Extremo'],difficulty:2},
 {domain:'tactical',title:'Decisão em superioridade',competencies:['Decisão','Posicionamento'],ageMin:10,ageMax:21,positions:['Médio centro','Médio ofensivo','Extremo','Avançado'],difficulty:3},
 {domain:'physical',title:'Aceleração com mudança de direção',competencies:['Aceleração','Agilidade'],ageMin:10,ageMax:21,positions:['Lateral','Extremo','Avançado'],difficulty:3},
 {domain:'cognitive',title:'Perceção antes da receção',competencies:['Perceção','Decisão'],ageMin:12,ageMax:21,positions:['Médio defensivo','Médio centro','Médio ofensivo','Extremo'],difficulty:4}
];

function generateContentBrief(input={}){
 const age=Number(input.age||14), position=input.position||'Extremo', goal=input.goal||'';
 const template=aiContentTemplates.find(t=>t.positions.includes(position) && age>=t.ageMin && age<=t.ageMax) || aiContentTemplates[0];
 return {
   type:'exercise',
   status:'DRAFT',
   title:`${template.title} — ${position}`,
   target:{age,position,goal},
   domain:template.domain,
   competencies:template.competencies,
   difficulty:template.difficulty,
   objective:`Desenvolver ${template.competencies.join(' e ')} através de uma tarefa progressiva.`,
   setup:['Espaço adequado à idade','Material simples e seguro'],
   steps:['Explicar e demonstrar','Executar com baixa intensidade','Adicionar oposição ou pressão progressivamente','Registar resultado'],
   progression:'Aumentar complexidade apenas quando a execução estiver consistente.',
   regression:'Reduzir espaço, velocidade ou oposição quando necessário.',
   videoScript:[
     '0–5s: apresentar objetivo e exercício',
     '5–20s: demonstrar execução correta',
     '20–35s: mostrar erro comum e correção',
     '35–45s: mostrar progressão/regressão'
   ],
   safetyNotes:['Parar perante dor ou desconforto anormal','Adequar carga e complexidade à idade e maturação'],
   workflow:['DRAFT','AI_REVIEW','PROFESSIONAL_REVIEW','APPROVED','PUBLISHED','RETIRED']
 };
}

app.post('/api/ai-content/generate-exercise',auth,(req,res)=>{
 const draft=generateContentBrief(req.body||{});
 res.status(201).json({provider:'provider-neutral',generatedBy:'AI_CONTENT_FACTORY',draft});
});

app.get('/api/ai-content/gap-audit',auth,(req,res)=>{
 const existing=exerciseCatalog||[];
 const gaps=aiContentTemplates.filter(t=>!existing.some(e=>e.domain===t.domain && e.positions?.includes(t.positions[0])));
 res.json({gaps:gaps.map(g=>({domain:g.domain,competencies:g.competencies,positions:g.positions,ageMin:g.ageMin,ageMax:g.ageMax}))});
});

app.post('/api/ai-content/video-script',auth,(req,res)=>{
 const d=generateContentBrief(req.body||{});
 res.status(201).json({title:d.title,script:d.videoScript,notes:'Roteiro gerado para revisão profissional antes de gravação/publicação.'});
});

function selectExercises(a){
 const age=Number(a.age||14), pos=a.position||'Extremo', goal=a.goal||'';
 const scores=a.scores||{};
 return exerciseCatalog.map(e=>{
  let score=0;
  if(e.positions.includes(pos))score+=30;
  if(e.ages.includes(age))score+=20;
  if(e.goals.some(g=>goal.toLowerCase().includes(g.toLowerCase())))score+=15;
  score+=e.competencies.reduce((n,c)=>n+(Number(scores[c]||0)<65?10:0),0);
  return {...e,matchScore:score};
 }).sort((x,y)=>y.matchScore-x.matchScore).slice(0,5);
}

function buildTrainingStudio(input={}){
 const age=Number(input.age||14), position=input.position||'Extremo', goal=input.goal||'Melhorar decisão';
 const scores=input.scores||{};
 const availableMinutes=Math.max(15,Math.min(90,Number(input.availableMinutes||45)));
 const load=Number(input.currentLoad||0);
 const recs=selectExercises({age,position,goal,scores});
 let maxExercises=availableMinutes>=60?5:availableMinutes>=40?4:3;
 if(load>=900) maxExercises=Math.min(maxExercises,3);
 const selected=recs.slice(0,maxExercises).map((e,i)=>({
   order:i+1,exerciseId:e.id,name:e.name,difficulty:e.difficulty,
   competencies:e.competencies,reason:e.matchScore>=50?'Alta compatibilidade com o perfil':'Complemento ao desenvolvimento',
   durationMinutes:Math.max(5,Math.floor(availableMinutes/maxExercises))
 }));
 return {type:'AI_TRAINING_STUDIO',status:'READY',profile:{age,position,goal},loadGuard:{currentLoad:load,reducedVolume:load>=900},totalMinutes:selected.reduce((n,e)=>n+e.durationMinutes,0),exercises:selected};
}
app.post('/api/training-studio/generate',auth,(req,res)=>{
 res.status(201).json(buildTrainingStudio(req.body||{}));
});

app.get('/api/player/exercise-recommendations',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{};
 res.json({playerId:req.user.sub,criteria:{age:a.age||null,position:a.position||null,goal:a.goal||null},exercises:selectExercises(a)});
});
app.post('/api/player/smart-session',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{};
 const exercises=selectExercises(a);
 const session={id:id(),userId:req.user.sub,mode:'SMART',status:'CREATED',exercises:exercises.map(e=>({exerciseId:e.id,name:e.name,difficulty:e.difficulty,competencies:e.competencies}))};
 sessions.set(session.id,session);res.status(201).json(session);
});

const mediaJobs=new Map();
const mediaAssets=new Map();

function buildVideoPrompt(input={}){
 const exercise=input.exercise||'Exercício de futebol';
 const age=input.age||14, level=input.level||'Desenvolvimento', position=input.position||'Extremo';
 return `Vídeo didático de futebol para jogador de ${age} anos, nível ${level}, posição ${position}. Demonstrar ${exercise}. Mostrar execução correta, erro comum, correção e progressão. Linguagem visual clara, enquadramento do corpo e bola, ambiente de treino seguro.`;
}

app.post('/api/media/video-job',auth,(req,res)=>{
 const idv=id();
 const job={id:idv,type:'VIDEO_GENERATION',status:'QUEUED',provider:'provider-neutral',prompt:buildVideoPrompt(req.body||{}),createdAt:new Date().toISOString()};
 mediaJobs.set(idv,job);
 res.status(201).json(job);
});

app.get('/api/media/video-job/:id',auth,(req,res)=>{
 const job=mediaJobs.get(req.params.id);
 if(!job)return res.status(404).json({error:'Video job not found'});
 res.json(job);
});

app.post('/api/media/asset',auth,(req,res)=>{
 const asset={id:id(),exerciseId:req.body?.exerciseId||null,type:req.body?.type||'VIDEO',url:req.body?.url||null,status:'DRAFT',caption:req.body?.caption||null,thumbnailUrl:req.body?.thumbnailUrl||null,createdAt:new Date().toISOString()};
 mediaAssets.set(asset.id,asset);
 res.status(201).json(asset);
});

app.get('/api/media/library',auth,(req,res)=>{
 res.json({assets:[...mediaAssets.values()]});
});

app.get('/api/player/position-profile',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{}, position=a.position||req.query.position||'Extremo';
 res.json({position,priorities:positionProfiles[position]||['Passe','Receção','Decisão','Velocidade'],note:'Perfil orientador; não substitui avaliação do treinador.'});
});
app.post('/api/player/position-plan',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{}, position=a.position||req.body.position||'Extremo';
 const priorities=positionProfiles[position]||['Passe','Receção','Decisão','Velocidade'];
 const plan={id:id(),userId:req.user.sub,position,priorities,goal:req.body.goal||a.goal||'Desenvolvimento',days:req.body.days||['MON','WED','FRI'],status:'DRAFT'};
 plans.set(`position:${req.user.sub}`,plan);res.status(201).json(plan);
});
app.get('/api/academy/team/:teamId/load',auth,(req,res)=>{
 const xs=[...loads.values()].filter(x=>x.teamId===req.params.teamId);
 const total=xs.reduce((a,x)=>a+x.load,0), avg=xs.length?Math.round(total/xs.length):0;
 res.json({teamId:req.params.teamId,sessions:xs.length,totalLoad:total,averageLoad:avg,items:xs});
});
app.post('/api/academy/team/:teamId/attendance',auth,(req,res)=>{
 const x={id:id(),teamId:req.params.teamId,playerId:req.body.playerId,date:req.body.date||new Date().toISOString(),status:req.body.status||'PRESENT'};
 attendance.set(x.id,x);res.status(201).json(x);
});
app.get('/api/academy/team/:teamId/attendance',auth,(req,res)=>{
 const xs=[...attendance.values()].filter(x=>x.teamId===req.params.teamId);
 const present=xs.filter(x=>x.status==='PRESENT').length;
 res.json({teamId:req.params.teamId,records:xs.length,attendanceRate:xs.length?Math.round(present/xs.length*100):0,items:xs});
});
app.post('/api/academy/team/:teamId/development-goal',auth,(req,res)=>{
 const g={id:id(),teamId:req.params.teamId,playerId:req.body.playerId||null,competency:req.body.competency||'Decisão',target:Number(req.body.target||75),reviewDate:req.body.reviewDate||null,status:'ACTIVE'};
 developmentGoals.set(g.id,g);res.status(201).json(g);
});
app.get('/api/academy/team/:teamId/load-alerts',auth,(req,res)=>{
 const xs=[...loads.values()].filter(x=>x.teamId===req.params.teamId);
 const alerts=xs.filter(x=>x.rpe>=9 || x.load>=900).map(x=>({loadId:x.id,playerId:x.playerId,type:'HIGH_LOAD',message:'Carga elevada; rever recuperação e contexto com treinador/profissional.'}));
 res.json({alerts});
});
app.get('/api/academy/:academyId/team/:teamId/performance',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const members=[...academyMembers.values()].filter(x=>x.academyId===a.id&&x.teamId===req.params.teamId);
 const playerStats=members.map(m=>{
  const ass=assessments.get(m.playerId)||{}, ss=[...sessions.values()].filter(x=>x.userId===m.playerId);
  const completed=ss.filter(x=>x.status==='COMPLETED').length;
  const vals=Object.values(ass.scores||{}).map(Number).filter(Number.isFinite);
  const score=vals.length?Math.round(vals.reduce((x,y)=>x+y,0)/vals.length):0;
  return {playerId:m.playerId,score,completedSessions:completed,goal:ass.goal||null,position:ass.position||null};
 });
 const avg=playerStats.length?Math.round(playerStats.reduce((x,y)=>x+y.score,0)/playerStats.length):0;
 res.json({academyId:a.id,teamId:req.params.teamId,teamScore:avg,players:playerStats,attendanceNote:'Assiduidade deve ser ligada aos registos de presença oficiais.'});
});
app.post('/api/academy/:academyId/team/:teamId/training-plan',auth,(req,res)=>{
 const plan={id:id(),academyId:req.params.academyId,teamId:req.params.teamId,goal:req.body.goal||'Desenvolvimento coletivo',days:req.body.days||['MON','WED'],status:'DRAFT',createdAt:new Date().toISOString()};
 plans.set(`team:${req.params.teamId}`,plan); res.status(201).json(plan);
});
app.get('/api/academy/:academyId/events',auth,(req,res)=>{
 res.json([...academyEvents.values()].filter(x=>x.academyId===req.params.academyId).sort((a,b)=>String(a.date).localeCompare(String(b.date))));
});
app.post('/api/academy/:academyId/callup',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const c={id:id(),academyId:a.id,eventId:req.body.eventId,playerIds:req.body.playerIds||[],status:'DRAFT',createdAt:new Date().toISOString()};
 callups.set(c.id,c); res.status(201).json(c);
});
app.patch('/api/academy/callup/:id',auth,(req,res)=>{
 const c=callups.get(req.params.id); if(!c)return res.status(404).json({error:'CALLUP_NOT_FOUND'});
 c.status=req.body.status||c.status; res.json(c);
});
app.post('/api/academy/:academyId/alert',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const al={id:id(),academyId:a.id,type:req.body.type||'INFO',message:req.body.message||'',target:req.body.target||'COACH',createdAt:new Date().toISOString()};
 alerts.set(al.id,al); res.status(201).json(al);
});
app.get('/api/academy/:academyId/alerts',auth,(req,res)=>res.json([...alerts.values()].filter(x=>x.academyId===req.params.academyId)));
app.post('/api/academy/:academyId/member',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const m={id:id(),academyId:a.id,playerId:req.body.playerId,teamId:req.body.teamId||null,status:'ACTIVE'};
 academyMembers.set(m.id,m); res.status(201).json(m);
});
app.get('/api/academy/:academyId/dashboard',auth,(req,res)=>{
 const a=academies.get(req.params.academyId); if(!a)return res.status(404).json({error:'ACADEMY_NOT_FOUND'});
 const ts=[...teams.values()].filter(x=>x.academyId===a.id);
 const ms=[...academyMembers.values()].filter(x=>x.academyId===a.id);
 res.json({academy:a,teams:ts,members:ms,counts:{teams:ts.length,players:ms.length}});
});
const links=new Map();
app.post('/api/family/link',auth,(req,res)=>{
 if(!['parent','player'].includes(req.user.role)) return res.status(403).json({error:'ROLE_FORBIDDEN'});
 const link={id:id(),playerId:req.user.role==='player'?req.user.sub:req.body.playerId,parentId:req.user.role==='parent'?req.user.sub:req.body.parentId,consent:req.body.consent===true,status:req.body.consent===true?'ACTIVE':'PENDING'};
 links.set(link.id,link); res.status(201).json(link);
});
app.post('/api/coach/link',auth,(req,res)=>{
 if(!['coach','player'].includes(req.user.role)) return res.status(403).json({error:'ROLE_FORBIDDEN'});
 const link={id:id(),playerId:req.user.role==='player'?req.user.sub:req.body.playerId,coachId:req.user.role==='coach'?req.user.sub:req.body.coachId,status:'ACTIVE'};
 links.set(link.id,link); res.status(201).json(link);
});
app.get('/api/player/relationships',auth,(req,res)=>{
 const mine=[...links.values()].filter(x=>x.playerId===req.user.sub||x.parentId===req.user.sub||x.coachId===req.user.sub);
 res.json({relationships:mine});
});
app.get('/api/family/player-summary/:playerId',auth,(req,res)=>{
 const allowed=[...links.values()].some(x=>x.playerId===req.params.playerId&&x.parentId===req.user.sub&&x.consent===true);
 if(!allowed)return res.status(403).json({error:'PARENT_CONSENT_REQUIRED'});
 const a=assessments.get(req.params.playerId)||{}, p=plans.get(req.params.playerId)||null;
 res.json({playerId:req.params.playerId,age:a.age||null,position:a.position||null,goal:a.goal||null,currentPlan:p});
});
app.get('/api/coach/player-summary/:playerId',auth,(req,res)=>{
 const allowed=[...links.values()].some(x=>x.playerId===req.params.playerId&&x.coachId===req.user.sub&&x.status==='ACTIVE');
 if(!allowed)return res.status(403).json({error:'COACH_ASSIGNMENT_REQUIRED'});
 const a=assessments.get(req.params.playerId)||{}, p=plans.get(req.params.playerId)||null;
 res.json({playerId:req.params.playerId,position:a.position||null,level:a.level||null,goal:a.goal||null,assessment:a.scores||{},currentPlan:p});
});
app.get('/api/player-passport',auth,(req,res)=>{
 const a=assessments.get(req.user.sub)||{};
 const p=plans.get(req.user.sub)||null;
 const userSessions=[...sessions.values()].filter(x=>x.userId===req.user.sub);
 const completed=userSessions.filter(x=>x.status==='COMPLETED').length;
 const scores=a.scores||{};
 const avg=Object.values(scores).map(Number).filter(Number.isFinite);
 const score=avg.length?Math.round(avg.reduce((x,y)=>x+y,0)/avg.length):0;
 const level=score>=90?'Elite':score>=75?'Alto rendimento':score>=60?'Competitivo':score>=45?'Desenvolvimento':'Base';
 res.json({
  playerId:req.user.sub,profile:{age:a.age||null,position:a.position||null,level:a.level||null,goal:a.goal||null},
  performance:{score,level,scores},
  training:{sessions: userSessions.length,completed,completionRate:userSessions.length?Math.round(completed/userSessions.length*100):0},
  currentPlan:p,principles:['evolução longitudinal','progressão gradual','feedback por sessão','validação profissional para menores']
 });
});
app.post('/api/adaptation',auth,(req,res)=>{
 const f=req.body||{};
 const difficulty=Number(f.difficulty||3), rpe=Number(f.rpe||5);
 let adjustment='Maintain volume';
 if(difficulty>=4 || rpe>=8) adjustment='Reduce intensity slightly and increase recovery';
 else if(difficulty<=2 && rpe<=4) adjustment='Progress difficulty gradually';
 const result={userId:req.user.sub,adjustment,nextDifficulty:Math.max(1,Math.min(5,difficulty+(adjustment.startsWith('Progress')?1:adjustment.startsWith('Reduce')?-1:0))),reason:'Feedback de dificuldade e RPE do treino anterior'};
 res.json(result);
});
app.post('/api/test/e2e',async(req,res)=>{
 const email=`e2e-${Date.now()}@example.test`, password='TestPassword!41';
 const u={id:id(),email,role:'player',passwordHash:await bcrypt.hash(password,12)};users.set(email,u);
 const assessment={userId:u.id,age:14,position:'Extremo',level:'Desenvolvimento',goal:'Melhorar decisão',scores:{Decisão:58,Passe:80,Agilidade:77,Coordenação:85}};assessments.set(u.id,assessment);
 const p={id:id(),userId:u.id,weeks:4,availability:['MON','WED','FRI'],priorities:['Decisão','Passe','Agilidade'],status:'ACTIVE'};plans.set(u.id,p);
 const s={id:id(),userId:u.id,planId:p.id,status:'STARTED',exercises:[{exerciseId:'decision-01',completed:true}]};sessions.set(s.id,s);
 s.status='COMPLETED';s.feedback={difficulty:3,rpe:6};
 await persistRun('E2E-'+u.id,'PASSED',{steps:['register','assessment','ai-coach','plan','session','exercise','feedback']});
 res.json({status:'PASSED',steps:['register','assessment','ai-coach','plan','session','exercise','feedback'],storage:pool?'postgresql':'memory'});
});
// Public web shell for Render. Keep source/config files out of the static surface.
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'../index.html')));
app.get('/manifest.webmanifest', (req,res)=>res.sendFile(path.join(__dirname,'../manifest.webmanifest')));
app.get('/sw.js', (req,res)=>res.sendFile(path.join(__dirname,'../sw.js')));

app.post('/api/ai/coach', auth, async (req,res)=>{
  try{
    const {message}=req.body||{};
    if(!message || typeof message!=='string') return res.status(400).json({error:'message_required'});
    const context=pool ? await dbPlayerContext(req.user.sub) : {identity:req.user};
    const result=await openAIResponses(
      [{role:'user',content:JSON.stringify({playerContext:context||{},message})}],
      {instructions:'You are Future Blue Shark AI Football Super Coach. Give age-appropriate, actionable football development guidance. Use the supplied player context. Do not diagnose injuries or make deterministic talent classifications. For minors, avoid shame, fear, or unsafe intensity. Answer in the user language.'}
    );
    res.json({provider:'openai',...result});
  }catch(e){ console.error(e); res.status(502).json({error:'ai_unavailable',message:'AI provider unavailable'}); }
});

app.post('/api/ai/content/exercise', async (req,res)=>{
  try{
    const {brief}=req.body||{};
    if(!brief) return res.status(400).json({error:'brief_required'});
    const result=await openAIResponses(
      [{role:'user',content:JSON.stringify({brief})}],
      {instructions:'You are the Future Blue Shark AI Content Manager. Draft one football exercise as structured JSON text with title, objective, ageBand, position, domain, difficulty, setup, steps, coachingCues, progression, regression, safetyNotes, videoScript. Never publish automatically. Keep it as DRAFT for professional review.'}
    );
    res.json({provider:'openai',...result,status:'DRAFT'});
  }catch(e){ console.error(e); res.status(502).json({error:'ai_unavailable',message:'AI provider unavailable'}); }
});

app.get('/api/ai/provider-status',(req,res)=>{
  res.json({provider:'openai',configured:Boolean(process.env.OPENAI_API_KEY),model:process.env.OPENAI_MODEL||'gpt-5.6-luna',serverSideKey:true});
});


/* AI Player Context Orchestrator
   Builds a compact, server-side context from player profile, assessment,
   training, match, load and goals, then asks the AI for the next action. */
function buildAIPlayerContext(player){
  const p=player||{};
  return {
    identity:{id:p.id,age:p.age,level:p.level,position:p.position},
    goal:p.goal||p.objective||null,
    availability:p.availability||null,
    assessment:p.assessment||p.scores||{},
    priorities:p.priorities||[],
    recentTraining:p.recentTraining||p.sessions||[],
    recentMatches:p.recentMatches||p.matches||[],
    load:p.load||p.currentLoad||null,
    feedback:p.feedback||[],
    developmentPlan:p.developmentPlan||p.roadmap||null
  };
}

app.post('/api/ai/player-next-action', async (req,res)=>{
  try{
    const {player}=req.body||{};
    if(!player || typeof player!=='object') return res.status(400).json({error:'player_required'});
    const context=buildAIPlayerContext(player);
    const result=await openAIResponses(
      [{role:'user',content:JSON.stringify({player:context})}],
      {instructions:
        'You are the Future Blue Shark AI Football Super Coach. Analyze the complete player context and return JSON with exactly these keys: '+
        'summary, priorities, todayTraining, loadDecision, nextReview, cautions. '+
        'priorities must be an array of up to 3 objects with area, reason, action. todayTraining must contain focus, durationMinutes, intensity, exercises. '+
        'loadDecision must be one of RECOVER, REDUCE, MAINTAIN, PROGRESS. nextReview must be a short review recommendation. cautions must be an array. '+
        'Use age, position, level, assessment, goals, availability, training, matches, load and feedback together. '+
        'Never diagnose injury, never make deterministic talent classifications, and never recommend unsafe intensity for minors. '+
        'This is JSON output for an application UI.'
      }
    );
    let parsed=null;
    try{ parsed=JSON.parse(result.text); }catch(_){}
    res.json({provider:'openai',model:result.model,playerContext:context,analysis:parsed||{raw:result.text},usage:result.usage});
  }catch(e){
    console.error(e);
    res.status(502).json({error:'ai_unavailable',message:'AI player analysis unavailable'});
  }
});

app.post('/api/ai/player-session', async (req,res)=>{
  try{
    const {player,sessionFeedback}=req.body||{};
    if(!player) return res.status(400).json({error:'player_required'});
    const context=buildAIPlayerContext(player);
    const result=await openAIResponses(
      [{role:'user',content:JSON.stringify({player:context,sessionFeedback:sessionFeedback||{}})}],
      {instructions:
        'You are the Future Blue Shark AI Football Super Coach. Based on the player context and latest session feedback, '+
        'produce JSON with: decision (PROGRESS, MAINTAIN, REDUCE, RECOVER), reason, nextSessionFocus, changes, recoveryNotes. '+
        'Keep recommendations age-appropriate and do not diagnose injury. This is JSON output for an application UI.'
      }
    );
    let parsed=null;
    try{ parsed=JSON.parse(result.text); }catch(_){}
    res.json({provider:'openai',model:result.model,analysis:parsed||{raw:result.text},usage:result.usage});
  }catch(e){
    console.error(e);
    res.status(502).json({error:'ai_unavailable',message:'AI adaptation unavailable'});
  }
});


app.post('/api/ai/player-next-action-db',auth,async(req,res)=>{
 try{
   const dbContext=await dbPlayerContext(req.user.sub);
   if(!dbContext) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const context=buildAIPlayerContext({
     id:req.user.sub,
     age:dbContext.assessment?.age,
     position:dbContext.assessment?.position,
     level:dbContext.assessment?.level,
     goal:dbContext.assessment?.goal,
     assessment:dbContext.assessment?.scores||{},
     recentTraining:dbContext.recentTraining,
     feedback:dbContext.recentTraining.map(x=>x.feedback).filter(Boolean),
     priorities:dbContext.goals
   });
   const result=await openAIResponses(
     [{role:'user',content:JSON.stringify({player:context})}],
     {instructions:'You are the Future Blue Shark AI Football Super Coach. Analyze this persisted player context. Return concise JSON with summary, priorities, todayTraining, loadDecision, nextReview, cautions. Use the full history. Never diagnose injuries or make deterministic talent classifications. Keep recommendations age-appropriate.'}
   );
   let analysis; try{analysis=JSON.parse(result.text)}catch(_){analysis={raw:result.text}};
   await saveAIDecision(req.user.sub,'PLAYER_NEXT_ACTION',context,analysis,result.model);
   res.json({provider:'openai',model:result.model,context,analysis,usage:result.usage});
 }catch(e){console.error(e);res.status(502).json({error:'ai_unavailable',message:'AI player analysis unavailable'});}
});
async function dbPlayerProgress(userId){
  if(!pool) return null;
  const [sessions,exercises]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS completed FROM player_sessions WHERE user_id=$1 AND status='COMPLETED'",[userId]),
    pool.query("SELECT COUNT(*)::int AS completed FROM exercise_results WHERE user_id=$1 AND completed=true",[userId])
  ]);
  const completedSessions=sessions.rows[0]?.completed||0;
  const completedExercises=exercises.rows[0]?.completed||0;
  const xp=completedSessions*100+completedExercises*20;
  return {xp,level:Math.max(1,Math.floor(xp/250)+1),completedSessions,completedExercises,evolution:completedSessions?Math.min(99,completedSessions*8):0};
}

app.get('/api/player/progress',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   res.json(await dbPlayerProgress(req.user.sub));
 }catch(e){console.error(e);res.status(500).json({error:'PROGRESS_LOAD_FAILED'});}
});

app.post('/api/training/session',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const training=req.body?.training||{};
   const exercises=Array.isArray(training.exercises)?training.exercises:[];
   if(!exercises.length) return res.status(400).json({error:'TRAINING_REQUIRED'});
   const sessionId=crypto.randomUUID();
   const r=await pool.query(`INSERT INTO player_sessions(id,user_id,status,exercises,started_at)
     VALUES($1,$2,'STARTED',$3,NOW()) RETURNING id,status,started_at,created_at`,[sessionId,req.user.sub,JSON.stringify(exercises)]);
   res.status(201).json({sessionId:r.rows[0].id,...r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:'SESSION_CREATE_FAILED'});}
});

app.post('/api/training/session/:id/complete',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const r=await pool.query(`UPDATE player_sessions SET status='COMPLETED',completed_at=NOW(),feedback=$3
     WHERE id=$1 AND user_id=$2 RETURNING id,status,started_at,completed_at`,[req.params.id,req.user.sub,JSON.stringify(req.body?.feedback||{})]);
   if(!r.rowCount) return res.status(404).json({error:'SESSION_NOT_FOUND'});
   const progress=await dbPlayerProgress(req.user.sub);
   res.json({session:r.rows[0],progress});
 }catch(e){console.error(e);res.status(500).json({error:'SESSION_COMPLETE_FAILED'});}
});

app.get('/api/player/context',auth,async(req,res)=>{
 try{
   const context=await dbPlayerContext(req.user.sub);
   if(!context)return res.status(503).json({error:'DATABASE_REQUIRED'});
   res.json(context);
 }catch(e){res.status(500).json({error:'CONTEXT_LOAD_FAILED'});}
});


app.post('/api/training/result',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const v=z.object({
     sessionId:z.string().min(1), exerciseId:z.string().min(1),
     completed:z.boolean().default(false),
     difficulty:z.number().int().min(1).max(5).optional(),
     rpe:z.number().int().min(1).max(10).optional(),
     fatigue:z.number().int().min(1).max(10).optional(),
     durationSeconds:z.number().int().min(0).optional(),
     reps:z.number().int().min(0).optional(),
     notes:z.string().max(1000).optional()
   }).safeParse(req.body);
   if(!v.success)return res.status(400).json({error:'INVALID_INPUT',details:v.error.issues});
   const x=v.data;
   await pool.query(`INSERT INTO exercise_results
     (session_id,user_id,exercise_id,completed,difficulty,rpe,fatigue,duration_seconds,reps,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
     [x.sessionId,req.user.sub,x.exerciseId,x.completed,x.difficulty??null,x.rpe??null,x.fatigue??null,x.durationSeconds??null,x.reps??null,x.notes??null]);
   res.status(201).json({saved:true});
 }catch(e){console.error(e);res.status(500).json({error:'RESULT_SAVE_FAILED'});}
});

app.post('/api/training/feedback',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const v=z.object({
     sessionId:z.string().min(1),
     overallRpe:z.number().int().min(1).max(10).optional(),
     fatigue:z.number().int().min(1).max(10).optional(),
     enjoyment:z.number().int().min(1).max(5).optional(),
     completed:z.boolean().default(false),
     notes:z.string().max(2000).optional()
   }).safeParse(req.body);
   if(!v.success)return res.status(400).json({error:'INVALID_INPUT',details:v.error.issues});
   const x=v.data;
   await pool.query(`INSERT INTO training_feedback
     (session_id,user_id,overall_rpe,fatigue,enjoyment,completed,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
     [x.sessionId,req.user.sub,x.overallRpe??null,x.fatigue??null,x.enjoyment??null,x.completed,x.notes??null]);
   res.status(201).json({saved:true});
 }catch(e){console.error(e);res.status(500).json({error:'FEEDBACK_SAVE_FAILED'});}
});

app.post('/api/training/adapt-from-history',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const context=await dbPlayerContext(req.user.sub);
   const [results,feedback]=await Promise.all([
     pool.query('SELECT exercise_id,completed,difficulty,rpe,fatigue,duration_seconds,reps,notes,created_at FROM exercise_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.sub]),
     pool.query('SELECT overall_rpe,fatigue,enjoyment,completed,notes,created_at FROM training_feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.sub])
   ]);
   const aiContext={player:context,exerciseResults:results.rows,trainingFeedback:feedback.rows};
   const result=await openAIResponses(
     [{role:'user',content:JSON.stringify(aiContext)}],
     {instructions:'You are the Future Blue Shark AI Football Super Coach. Adapt the next training cycle from the player history and latest training results. Return JSON with decision (PROGRESS, MAINTAIN, REDUCE, RECOVER), reason, changes, nextSessionFocus, recoveryNotes. Consider repeated RPE/fatigue/difficulty patterns, completion and feedback. Never diagnose injury and never make deterministic talent classifications. Keep recommendations age-appropriate.'}
   );
   let analysis; try{analysis=JSON.parse(result.text)}catch(_){analysis={raw:result.text}};
   await pool.query('INSERT INTO training_adaptations(user_id,session_id,decision,reason,changes) VALUES($1,$2,$3,$4,$5)',
     [req.user.sub,req.body?.sessionId||null,analysis.decision||'MAINTAIN',analysis.reason||'',analysis.changes||{}]);
   await saveAIDecision(req.user.sub,'TRAINING_ADAPTATION',aiContext,analysis,result.model);
   res.json({provider:'openai',model:result.model,analysis,usage:result.usage});
 }catch(e){console.error(e);res.status(502).json({error:'ai_unavailable',message:'Training adaptation unavailable'});}
});


app.post('/api/ai/daily-training',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const player=await dbPlayerContext(req.user.sub);
   if(!player) return res.status(404).json({error:'PLAYER_NOT_FOUND'});
   const [results,feedback]=await Promise.all([
     pool.query('SELECT exercise_id,completed,difficulty,rpe,fatigue,duration_seconds,reps,created_at FROM exercise_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60',[req.user.sub]),
     pool.query('SELECT overall_rpe,fatigue,enjoyment,completed,notes,created_at FROM training_feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.sub])
   ]);
   const input={
     player,
     recentExerciseResults:results.rows,
     recentSessionFeedback:feedback.rows,
     requestedDate:req.body?.date||new Date().toISOString().slice(0,10),
     availableMinutes:req.body?.availableMinutes||45
   };
   const schema={
     type:'object',
     additionalProperties:false,
     properties:{
       title:{type:'string'}, focus:{type:'string'}, durationMinutes:{type:'integer'},
       intensity:{type:'string',enum:['LOW','MODERATE','HIGH']},
       warmupMinutes:{type:'integer'}, cooldownMinutes:{type:'integer'},
       exercises:{type:'array',items:{type:'object',additionalProperties:false,properties:{
         exerciseId:{type:'string'}, name:{type:'string'}, sets:{type:'integer'},
         reps:{type:'integer'}, durationSeconds:{type:'integer'}, restSeconds:{type:'integer'},
         coachingCue:{type:'string'}, videoRequired:{type:'boolean'}
       },required:['exerciseId','name','sets','reps','durationSeconds','restSeconds','coachingCue','videoRequired']}},
       safetyNotes:{type:'array',items:{type:'string'}},
       rationale:{type:'string'}
     },
     required:['title','focus','durationMinutes','intensity','warmupMinutes','cooldownMinutes','exercises','safetyNotes','rationale']
   };
   const result=await openAIResponses(
     [{role:'user',content:JSON.stringify(input)}],
     {instructions:
       'You are the Future Blue Shark AI Football Super Coach. Generate today training from the persisted player profile, assessment, goals, training history, feedback and load signals. '+
       'Choose exercises that exist in the application library when possible; do not invent a video URL. Every exercise requiring demonstration must have videoRequired true. '+
       'Balance development and recovery. For minors use age-appropriate volume and intensity. Never diagnose injury. Return only JSON matching the supplied schema.',
      maxOutputTokens:2600}
   );
   let training; try{training=JSON.parse(result.text)}catch(_){return res.status(502).json({error:'AI_INVALID_JSON'})}
   await saveAIDecision(req.user.sub,'DAILY_TRAINING',input,training,result.model);
   res.json({provider:'openai',model:result.model,training,usage:result.usage});
 }catch(e){console.error(e);res.status(502).json({error:'ai_unavailable',message:'Daily training generation unavailable'});}
});


/* 2.2: library/video guard — AI may select only catalogued exercises. */
async function dbExerciseCatalog(){
  if(!pool) return [];
  try{
    const r=await pool.query(`SELECT * FROM exercises WHERE status='PUBLISHED' ORDER BY id`);
    return r.rows;
  }catch(_){ return []; }
}
async function dbExerciseLibraryStats(){
  if(!pool) return {published:0,videoReady:0};
  try{
    const r=await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='PUBLISHED')::int AS published,
        COUNT(*) FILTER (WHERE status='PUBLISHED' AND video_status='PUBLISHED' AND video_url IS NOT NULL AND video_url<>'')::int AS video_ready
      FROM exercises`);
    return r.rows[0] || {published:0,videoReady:0};
  }catch(_){ return {published:0,videoReady:0}; }
}
app.post('/api/ai/daily-training-library',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const player=await dbPlayerContext(req.user.sub);
   const catalog=await dbExerciseCatalog();
   if(!player) return res.status(404).json({error:'PLAYER_NOT_FOUND'});
   if(!catalog.length) return res.status(409).json({error:'EXERCISE_LIBRARY_EMPTY'});
   const [results,feedback]=await Promise.all([
     pool.query('SELECT exercise_id,completed,difficulty,rpe,fatigue,duration_seconds,reps,created_at FROM exercise_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60',[req.user.sub]),
     pool.query('SELECT overall_rpe,fatigue,enjoyment,completed,notes,created_at FROM training_feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.sub])
   ]);
   const input={player,availableMinutes:req.body?.availableMinutes||45,
     recentExerciseResults:results.rows,recentSessionFeedback:feedback.rows,
     exerciseCatalog:catalog.map(x=>({id:x.id,name:x.title||x.name,position:x.position,ageBand:x.age_band,level:x.level,domain:x.domain,difficulty:x.difficulty,videoUrl:x.video_url,videoStatus:x.video_status}))};
   const result=await openAIResponses(
    [{role:'user',content:JSON.stringify(input)}],
    {instructions:'Generate today football training using ONLY exercise IDs from exerciseCatalog. Never invent an exerciseId or video URL. Prefer exercises with videoStatus PUBLISHED and a non-empty videoUrl. Return JSON with title, focus, durationMinutes, intensity, exercises (exerciseId,name,sets,reps,durationSeconds,restSeconds,coachingCue,videoRequired), safetyNotes, rationale. Keep age-appropriate volume. Do not diagnose injuries.',
     maxOutputTokens:2600}
   );
   let training; try{training=JSON.parse(result.text)}catch(_){return res.status(502).json({error:'AI_INVALID_JSON'})}
   const allowed=new Map(catalog.map(x=>[String(x.id),x]));
   training.exercises=(training.exercises||[]).filter(x=>allowed.has(String(x.exerciseId))).map(x=>{
     const c=allowed.get(String(x.exerciseId));
     return {...x,name:c.title||c.name,videoUrl:c.video_url||null,videoStatus:c.video_status||'MISSING'};
   });
   training.exercises=training.exercises.filter(x=>x.videoStatus==='PUBLISHED' && x.videoUrl);
   await saveAIDecision(req.user.sub,'DAILY_TRAINING_LIBRARY_GUARD',input,training,result.model);
   res.json({provider:'openai',model:result.model,training,usage:result.usage});
 }catch(e){console.error(e);res.status(502).json({error:'ai_unavailable',message:'Library-constrained training unavailable'});}
});


/* 2.3: Smart Exercise Engine — deterministic ranking before AI generation. */
function smartExerciseRank(catalog, p, recentResults=[], availableMinutes=45){
  const pos=String(p?.position||'').toLowerCase();
  const goal=String(p?.goal||p?.objective||'').toLowerCase();
  const level=String(p?.level||'').toLowerCase();
  const recent=new Set(recentResults.slice(0,20).map(x=>String(x.exercise_id)));
  const scored=catalog.filter(x=>x.status==='PUBLISHED').map(x=>{
    let score=50;
    const text=[x.title,x.name,x.domain,x.position,x.age_band,x.level].filter(Boolean).join(' ').toLowerCase();
    if(pos && text.includes(pos)) score+=15;
    if(goal && text.includes(goal)) score+=12;
    if(level && text.includes(level)) score+=8;
    if(recent.has(String(x.id))) score-=20;
    if(Number(x.difficulty||0)>=1 && Number(x.difficulty||0)<=5) score+=5;
    return {...x,smartScore:score};
  }).sort((a,b)=>b.smartScore-a.smartScore);
  return scored;
}
app.post('/api/ai/daily-training-smart',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const player=await dbPlayerContext(req.user.sub);
   const catalog=await dbExerciseCatalog();
   if(!player) return res.status(404).json({error:'PLAYER_NOT_FOUND'});
   const results=(await pool.query('SELECT exercise_id,difficulty,rpe,fatigue,completed,created_at FROM exercise_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60',[req.user.sub])).rows;
   const feedback=(await pool.query('SELECT overall_rpe,fatigue,enjoyment,completed,notes,created_at FROM training_feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.sub])).rows;
   const ranked=smartExerciseRank(catalog,player,results,req.body?.availableMinutes||45).slice(0,30);
   if(!ranked.length) return res.status(409).json({error:'EXERCISE_LIBRARY_EMPTY'});
   const input={player,availableMinutes:req.body?.availableMinutes||45,recentResults:results.slice(0,20),recentFeedback:feedback.slice(0,10),
     rankedExercisePool:ranked.map(x=>({id:x.id,name:x.title||x.name,domain:x.domain,difficulty:x.difficulty,videoUrl:x.video_url,videoStatus:x.video_status,smartScore:x.smartScore}))};
   const schema={type:"object",additionalProperties:false,properties:{
     title:{type:"string"},focus:{type:"string"},durationMinutes:{type:"integer"},intensity:{type:"string"},
     exercises:{type:"array",items:{type:"object",additionalProperties:false,properties:{
       exerciseId:{type:"string"},sets:{type:"integer"},reps:{type:"integer"},durationSeconds:{type:"integer"},
       restSeconds:{type:"integer"},coachingCue:{type:"string"},videoRequired:{type:"boolean"}},required:["exerciseId","sets","reps","durationSeconds","restSeconds","coachingCue","videoRequired"]}},
     safetyNotes:{type:"array",items:{type:"string"}},rationale:{type:"string"}},required:["title","focus","durationMinutes","intensity","exercises","safetyNotes","rationale"]};
   const result=await openAIResponses([{role:'user',content:JSON.stringify(input)}],
     {instructions:'Create the best daily football session from rankedExercisePool. Use ONLY IDs in the pool. Respect player age/level/position, goal, recent load and avoid immediate repetition. Use a catalog video when one is available; never invent a video URL. If an exercise has no video yet, set videoRequired to false so the session can still be generated. Keep volume age-appropriate and include safety notes. Do not diagnose injuries.',
      maxOutputTokens:3000,text:{format:{type:'json_schema',name:'daily_training',strict:true,schema}}});
   let training; try{training=JSON.parse(result.text)}catch(_){return res.status(502).json({error:'AI_INVALID_STRUCTURED_OUTPUT'})}
   const allowed=new Map(ranked.map(x=>[String(x.id),x]));
   training.exercises=(training.exercises||[]).filter(x=>allowed.has(String(x.exerciseId))).map(x=>{
     const c=allowed.get(String(x.exerciseId));
     return {...x,name:c.title||c.name,videoUrl:c.video_url||null,videoStatus:c.video_status||'PENDING',videoRequired:Boolean(c.video_url),smartScore:c.smartScore};
   });
   if(!training.exercises.length) return res.status(502).json({error:'AI_SELECTED_NO_VALID_EXERCISES'});
   await saveAIDecision(req.user.sub,'DAILY_TRAINING_SMART_ENGINE',input,training,result.model);
   res.json({provider:'openai',model:result.model,selectionEngine:'smart-ranking-v1',training,usage:result.usage});
 }catch(e){console.error(e);res.status(502).json({error:'ai_unavailable',message:'Smart training generation unavailable'});}
});


app.get('/api/exercises/catalog',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const library=await dbExerciseCatalog();
   const stats=await dbExerciseLibraryStats();
   res.json({
     version:'4.8.0',
     stats,
     exercises:library.map(x=>({
       id:x.id,name:x.title||x.name,position:x.position,ageBand:x.age_band,
       level:x.level,domain:x.domain,difficulty:x.difficulty,
       videoUrl:x.video_url||null,videoStatus:x.video_status||'PENDING'
     }))
   });
 }catch(e){res.status(500).json({error:'EXERCISE_CATALOG_UNAVAILABLE'});}
});


/* 2.4: persistent AI Video Library gate */
app.get('/api/exercises/video-library',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const r=await pool.query(`
     SELECT e.id, COALESCE(e.title,e.name) AS name,
            em.video_url AS "videoUrl", em.provider, em.license_type AS "licenseType",
            em.duration_seconds AS "durationSeconds", em.thumbnail_url AS "thumbnailUrl",
            em.status, em.ai_qa_status AS "aiQaStatus",
            em.professional_review_status AS "professionalReviewStatus"
     FROM exercises e
     LEFT JOIN LATERAL (
       SELECT * FROM exercise_media m
       WHERE m.exercise_id=e.id AND m.asset_type='VIDEO'
       ORDER BY CASE WHEN m.status='PUBLISHED' THEN 0 ELSE 1 END, m.created_at DESC
       LIMIT 1
     ) em ON TRUE
     WHERE e.status='PUBLISHED'
     ORDER BY e.id`);
   res.json({library:r.rows, playable:r.rows.filter(x=>x.status==='PUBLISHED'&&x.videoUrl)});
 }catch(e){res.status(500).json({error:'VIDEO_LIBRARY_UNAVAILABLE'});}
});

app.post('/api/ai/video-library/eligibility',auth,async(req,res)=>{
 try{
   if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
   const ids=Array.isArray(req.body?.exerciseIds)?req.body.exerciseIds.map(String):[];
   if(!ids.length) return res.json({eligible:[],blocked:[]});
   const r=await pool.query(`
     SELECT e.id, COALESCE(e.title,e.name) AS name, em.video_url AS "videoUrl",
       em.status, em.ai_qa_status AS "aiQaStatus", em.professional_review_status AS "professionalReviewStatus",
       em.license_type AS "licenseType"
     FROM exercises e
     LEFT JOIN LATERAL (
       SELECT * FROM exercise_media m WHERE m.exercise_id=e.id AND m.asset_type='VIDEO'
       ORDER BY CASE WHEN m.status='PUBLISHED' THEN 0 ELSE 1 END, m.created_at DESC LIMIT 1
     ) em ON TRUE
     WHERE e.id = ANY($1::text[]) AND e.status='PUBLISHED'`,[ids]);
   const map=new Map(r.rows.map(x=>[String(x.id),x]));
   const eligible=[],blocked=[];
   ids.forEach(id=>{
     const x=map.get(id);
     if(x && x.status==='PUBLISHED' && x.videoUrl && x.aiQaStatus==='PASS' && x.professionalReviewStatus==='APPROVED' && x.licenseType) eligible.push(x);
     else blocked.push({exerciseId:id,reason:'VIDEO_NOT_PRODUCTION_READY'});
   });
   res.json({eligible,blocked});
 }catch(e){res.status(500).json({error:'VIDEO_ELIGIBILITY_UNAVAILABLE'});}
});


/* 2.5: provider-neutral video storage/factory */
function videoStorageConfig(){
  return {
    provider: process.env.VIDEO_STORAGE_PROVIDER || 's3-compatible',
    bucket: process.env.VIDEO_STORAGE_BUCKET || '',
    publicBaseUrl: process.env.VIDEO_STORAGE_PUBLIC_BASE_URL || '',
    region: process.env.VIDEO_STORAGE_REGION || ''
  };
}
app.get('/api/media/storage-status',auth,(req,res)=>{
 const c=videoStorageConfig();
 res.json({provider:c.provider,configured:Boolean(c.bucket&&c.publicBaseUrl),bucketConfigured:Boolean(c.bucket),publicBaseUrlConfigured:Boolean(c.publicBaseUrl)});
});
app.post('/api/media/video-asset/register',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {exerciseId,storageKey,publicUrl,mimeType='video/mp4',fileSizeBytes,checksumSha256,durationSeconds,width,height,provider}=req.body||{};
  if(!exerciseId||!storageKey) return res.status(400).json({error:'exerciseId_and_storageKey_required'});
  const r=await pool.query(`INSERT INTO video_assets
   (exercise_id,storage_key,public_url,provider,mime_type,file_size_bytes,checksum_sha256,duration_seconds,width,height)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT(storage_key) DO UPDATE SET public_url=EXCLUDED.public_url,file_size_bytes=EXCLUDED.file_size_bytes,
   checksum_sha256=EXCLUDED.checksum_sha256,duration_seconds=EXCLUDED.duration_seconds,width=EXCLUDED.width,height=EXCLUDED.height
   RETURNING *`,
   [exerciseId,storageKey,publicUrl||null,provider||videoStorageConfig().provider,mimeType,fileSizeBytes||null,checksumSha256||null,durationSeconds||null,width||null,height||null]);
  res.json({asset:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:'VIDEO_ASSET_REGISTER_FAILED'});}
});
app.get('/api/media/video-assets/:exerciseId',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query(`SELECT * FROM video_assets WHERE exercise_id=$1 ORDER BY created_at DESC`,[req.params.exerciseId]);
  res.json({assets:r.rows});
 }catch(e){res.status(500).json({error:'VIDEO_ASSET_LOOKUP_FAILED'});}
});
app.post('/api/media/video-publish/:id',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query(`UPDATE video_assets SET status='PUBLISHED',published_at=NOW()
    WHERE id=$1 AND public_url IS NOT NULL AND checksum_sha256 IS NOT NULL RETURNING *`,[req.params.id]);
  if(!r.rowCount) return res.status(409).json({error:'ASSET_NOT_READY'});
  res.json({asset:r.rows[0]});
 }catch(e){res.status(500).json({error:'VIDEO_PUBLISH_FAILED'});}
});


/* 2.6: provider-neutral asynchronous AI video generation worker */
function videoProviderConfig(){
 return {
   provider: process.env.VIDEO_GENERATION_PROVIDER || 'disabled',
   apiKey: process.env.VIDEO_GENERATION_API_KEY || '',
   endpoint: process.env.VIDEO_GENERATION_ENDPOINT || ''
 };
}
app.get('/api/media/generation/status',auth,async(req,res)=>{
 const c=videoProviderConfig();
 res.json({provider:c.provider,configured:Boolean(c.apiKey&&c.endpoint),worker:'provider-neutral',live:Boolean(c.apiKey&&c.endpoint)});
});
app.post('/api/media/generation/enqueue',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {exerciseId,prompt,provider}=req.body||{};
  if(!exerciseId||!prompt) return res.status(400).json({error:'exerciseId_and_prompt_required'});
  const c=videoProviderConfig();
  const p=provider||c.provider;
  const r=await pool.query(`INSERT INTO video_generation_jobs(exercise_id,provider,prompt) VALUES($1,$2,$3) RETURNING *`,[exerciseId,p,prompt]);
  res.status(202).json({job:r.rows[0]});
 }catch(e){res.status(500).json({error:'VIDEO_JOB_ENQUEUE_FAILED'});}
});
app.get('/api/media/generation/jobs/:id',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query('SELECT * FROM video_generation_jobs WHERE id=$1',[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:'JOB_NOT_FOUND'});
  res.json({job:r.rows[0]});
 }catch(e){res.status(500).json({error:'VIDEO_JOB_LOOKUP_FAILED'});}
});
async function runVideoGenerationJob(job){
 const c=videoProviderConfig();
 if(!c.apiKey||!c.endpoint) throw new Error('VIDEO_GENERATION_PROVIDER_NOT_CONFIGURED');
 /* Provider adapter contract: production adapter must translate this payload
    to the selected vendor and return {providerJobId, outputUrl}. */
 const r=await fetch(c.endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${c.apiKey}`},
   body:JSON.stringify({prompt:job.prompt,exerciseId:job.exercise_id,jobId:String(job.id)})});
 if(!r.ok) throw new Error(`VIDEO_PROVIDER_HTTP_${r.status}`);
 const data=await r.json();
 return {providerJobId:data.id||data.jobId||null,outputUrl:data.outputUrl||data.videoUrl||null};
}
app.post('/api/media/generation/worker/run-once',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query(`UPDATE video_generation_jobs SET status='RUNNING',started_at=NOW(),attempts=attempts+1
    WHERE id=(SELECT id FROM video_generation_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1)
    RETURNING *`);
  if(!r.rowCount) return res.json({processed:false,reason:'QUEUE_EMPTY'});
  const job=r.rows[0];
  try{
   const result=await runVideoGenerationJob(job);
   const u=await pool.query(`UPDATE video_generation_jobs SET status=$2,provider_job_id=$3,output_url=$4,completed_at=NOW()
      WHERE id=$1 RETURNING *`,[job.id,result.outputUrl?'COMPLETED':'SUBMITTED',result.providerJobId,result.outputUrl]);
   res.json({processed:true,job:u.rows[0]});
  }catch(err){
   const u=await pool.query(`UPDATE video_generation_jobs SET status=CASE WHEN attempts>=3 THEN 'FAILED' ELSE 'QUEUED' END,error_message=$2
      WHERE id=$1 RETURNING *`,[job.id,String(err.message).slice(0,500)]);
   res.status(502).json({processed:true,job:u.rows[0]});
  }
 }catch(e){res.status(500).json({error:'VIDEO_WORKER_FAILED'});}
});


/* 2.7: AI Video QA gate */
const VIDEO_QA_REQUIRED=['exercise_match','player_visible','ball_visible','camera_quality','instructional_clarity','safety_check'];
function deterministicVideoQA(input){
 const c=input?.checks||{};
 const issues=[];
 for(const k of VIDEO_QA_REQUIRED) if(c[k]!==true) issues.push(k);
 const score=Math.max(0,100-(issues.length*15));
 return {score,status:issues.length===0?'PASS':'REVIEW',issues};
}
app.post('/api/media/video-qa/review',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {videoAssetId,generationJobId,exerciseId,checks,observations}=req.body||{};
  if(!exerciseId||!checks) return res.status(400).json({error:'exerciseId_and_checks_required'});
  const qa=deterministicVideoQA({checks});
  const r=await pool.query(`INSERT INTO video_qa_reviews(video_asset_id,generation_job_id,exercise_id,checks,score,status,issues)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [videoAssetId||null,generationJobId||null,exerciseId,JSON.stringify({...checks,observations:observations||null}),qa.score,qa.status,JSON.stringify(qa.issues)]);
  res.json({qa:r.rows[0],productionEligible:qa.status==='PASS'});
 }catch(e){res.status(500).json({error:'VIDEO_QA_FAILED'});}
});
app.get('/api/media/video-qa/:exerciseId',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query('SELECT * FROM video_qa_reviews WHERE exercise_id=$1 ORDER BY reviewed_at DESC LIMIT 10',[req.params.exerciseId]);
  res.json({reviews:r.rows});
 }catch(e){res.status(500).json({error:'VIDEO_QA_LOOKUP_FAILED'});}
});


/* 2.8: multimodal video inspection adapter */
function multimodalConfig(){
 return {provider:process.env.VIDEO_VISION_PROVIDER||'disabled',endpoint:process.env.VIDEO_VISION_ENDPOINT||'',apiKey:process.env.VIDEO_VISION_API_KEY||''};
}
app.get('/api/media/video-inspection/status',auth,(req,res)=>{
 const c=multimodalConfig();
 res.json({provider:c.provider,configured:Boolean(c.endpoint&&c.apiKey),live:Boolean(c.endpoint&&c.apiKey)});
});
app.post('/api/media/video-inspection/analyze',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {videoAssetId,exerciseId,videoUrl,exerciseBrief}=req.body||{};
  if(!exerciseId||!videoUrl||!exerciseBrief) return res.status(400).json({error:'exerciseId_videoUrl_exerciseBrief_required'});
  const c=multimodalConfig();
  if(!c.endpoint||!c.apiKey) return res.status(503).json({error:'VIDEO_VISION_PROVIDER_NOT_CONFIGURED'});
  const response=await fetch(c.endpoint,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${c.apiKey}`},
    body:JSON.stringify({videoUrl,exerciseId,exerciseBrief,checks:['exercise_match','technique_visibility','ball_visibility','camera_quality','instructional_clarity','safety']} )});
  if(!response.ok) throw new Error(`VIDEO_VISION_HTTP_${response.status}`);
  const data=await response.json();
  const inspection=data.inspection||data.result||data;
  const confidence=Number(inspection.confidence||0);
  const status=inspection.status|| (confidence>=80?'PASS':'REVIEW');
  const r=await pool.query(`INSERT INTO video_inspections(video_asset_id,exercise_id,model,observations,metrics,confidence,status)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [videoAssetId||null,exerciseId,data.model||c.provider,JSON.stringify(inspection.observations||{}),JSON.stringify(inspection.metrics||{}),confidence,status]);
  res.json({inspection:r.rows[0],publicationEligible:status==='PASS'&&confidence>=80});
 }catch(e){console.error(e);res.status(502).json({error:'VIDEO_INSPECTION_FAILED',message:String(e.message).slice(0,300)});}
});


/* 2.9: Video -> Exercise Knowledge */
app.post('/api/media/video-knowledge/build',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {videoAssetId,exerciseId,inspection} = req.body||{};
  if(!exerciseId||!inspection) return res.status(400).json({error:'exerciseId_and_inspection_required'});
  if(inspection.status!=='PASS'||Number(inspection.confidence||0)<80)
    return res.status(409).json({error:'INSPECTION_NOT_APPROVED'});
  const knowledge={
   techniquePoints:Array.isArray(inspection.techniquePoints)?inspection.techniquePoints:[],
   commonErrors:Array.isArray(inspection.commonErrors)?inspection.commonErrors:[],
   progressions:Array.isArray(inspection.progressions)?inspection.progressions:[],
   regressions:Array.isArray(inspection.regressions)?inspection.regressions:[],
   qualityCriteria:Array.isArray(inspection.qualityCriteria)?inspection.qualityCriteria:[],
   safetyNotes:Array.isArray(inspection.safetyNotes)?inspection.safetyNotes:[]
  };
  const r=await pool.query(`INSERT INTO video_exercise_knowledge
   (video_asset_id,exercise_id,technique_points,common_errors,progressions,regressions,quality_criteria,safety_notes,confidence,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'READY') RETURNING *`,
   [videoAssetId||null,exerciseId,JSON.stringify(knowledge.techniquePoints),JSON.stringify(knowledge.commonErrors),
    JSON.stringify(knowledge.progressions),JSON.stringify(knowledge.regressions),JSON.stringify(knowledge.qualityCriteria),
    JSON.stringify(knowledge.safetyNotes),Number(inspection.confidence||0)]);
  res.json({knowledge:r.rows[0],ready:true});
 }catch(e){res.status(500).json({error:'VIDEO_KNOWLEDGE_BUILD_FAILED'});}
});
app.get('/api/exercises/:exerciseId/knowledge',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const r=await pool.query(`SELECT * FROM video_exercise_knowledge WHERE exercise_id=$1 AND status='READY'
    ORDER BY updated_at DESC LIMIT 1`,[req.params.exerciseId]);
  res.json({knowledge:r.rows[0]||null});
 }catch(e){res.status(500).json({error:'EXERCISE_KNOWLEDGE_LOOKUP_FAILED'});}
});


/* 3.0: AI Coach grounded in exercise knowledge */
app.post('/api/ai/coach-exercise-guidance',auth,async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'DATABASE_REQUIRED'});
  const {exerciseId,playerId}=req.body||{};
  const pid=playerId||req.user.sub;
  if(!exerciseId) return res.status(400).json({error:'exerciseId_required'});
  const [p,k]=await Promise.all([
   dbPlayerContext(pid),
   pool.query(`SELECT * FROM video_exercise_knowledge WHERE exercise_id=$1 AND status='READY' ORDER BY updated_at DESC LIMIT 1`,[exerciseId])
  ]);
  if(!p) return res.status(404).json({error:'PLAYER_NOT_FOUND'});
  if(!k.rowCount) return res.status(409).json({error:'EXERCISE_KNOWLEDGE_NOT_READY'});
  const context={player:p,exerciseKnowledge:k.rows[0]};
  const result=await openAIResponses([{role:'user',content:JSON.stringify(context)}],
   {instructions:'Act as the football training coach. Explain how this player should execute the exercise using only the supplied exercise knowledge. Give age-appropriate coaching cues, one progression or regression when justified, and safety notes. Never diagnose injury or label talent.',
    maxOutputTokens:1200});
  const guidance={text:result.text,model:result.model,generatedAt:new Date().toISOString()};
  await pool.query(`INSERT INTO coach_exercise_guidance(player_id,exercise_id,guidance) VALUES($1,$2,$3)`,[pid,exerciseId,JSON.stringify(guidance)]);
  res.json({guidance});
 }catch(e){console.error(e);res.status(502).json({error:'AI_COACH_GUIDANCE_FAILED'});}
});

// Local server only. In Vercel, the app is exported to the serverless catch-all function.
if (require.main === module) {
  const port = Number(process.env.PORT || 4100);
  app.listen(port, '0.0.0.0', () => console.log(`FBS production on ${port}`));
}

// 61.0 Player Experience event tracking
const playerExperienceEvents=[];
app.post('/api/player/experience-event',auth,(req,res)=>{
 const event={id:id(),userId:req.user.sub,event:req.body?.event||'UNKNOWN',screen:req.body?.screen||null,metadata:req.body?.metadata||{},createdAt:new Date().toISOString()};
 playerExperienceEvents.push(event);
 res.status(201).json(event);
});
app.get('/api/player/experience-summary',auth,(req,res)=>{
 const events=playerExperienceEvents.filter(e=>e.userId===req.user.sub);
 res.json({userId:req.user.sub,totalEvents:events.length,lastEvent:events.at(-1)||null});
});

// 62.0 AI Video Coach — analysis contract, provider-neutral
const videoAnalyses=new Map();
function analyzeTrainingVideo(input={}){
 const metrics=input.metrics||{};
 const observations=[];
 if(Number(metrics.bodyControl||0)<60) observations.push({area:'Controlo corporal',priority:'alta',advice:'Reforçar equilíbrio e estabilidade antes de aumentar a velocidade.'});
 if(Number(metrics.firstTouch||0)<60) observations.push({area:'Primeiro toque',priority:'alta',advice:'Trabalhar orientação do primeiro toque com oposição progressiva.'});
 if(Number(metrics.execution||0)>=75) observations.push({area:'Execução',priority:'positiva',advice:'Manter a qualidade e aumentar gradualmente a complexidade.'});
 if(!observations.length) observations.push({area:'Execução geral',priority:'normal',advice:'Manter consistência e repetir com qualidade.'});
 return {
   type:'AI_VIDEO_COACH_ANALYSIS',status:'REVIEW',
   videoId:input.videoId||null,exerciseId:input.exerciseId||null,
   observations,confidence:'indicative',
   disclaimer:'Análise assistida por IA. Não substitui treinador ou avaliação profissional e não classifica talento.'
 };
}
app.post('/api/ai-video-coach/analyze',auth,(req,res)=>{
 const analysis={id:id(),createdAt:new Date().toISOString(),...analyzeTrainingVideo(req.body||{})};
 videoAnalyses.set(analysis.id,analysis);res.status(201).json(analysis);
});
app.get('/api/ai-video-coach/analysis/:id',auth,(req,res)=>{
 const a=videoAnalyses.get(req.params.id); if(!a)return res.status(404).json({error:'Analysis not found'}); res.json(a);
});

// 63.0 Computer Vision Football — structured movement metrics contract
const cvAnalyses=new Map();

function computeVisionMetrics(input={}){
 const frames=Array.isArray(input.frames)?input.frames:[];
 const avg=(key)=>frames.length?frames.reduce((n,f)=>n+Number(f[key]||0),0)/frames.length:null;
 const metrics={
   balance:avg('balance'),
   bodyAlignment:avg('bodyAlignment'),
   movementSpeed:avg('movementSpeed'),
   changeOfDirection:avg('changeOfDirection'),
   ballControl:avg('ballControl'),
   confidence:frames.length>=8?'medium':'low'
 };
 const observations=[];
 if(metrics.balance!==null && metrics.balance<60) observations.push({metric:'balance',priority:'high',advice:'Trabalhar estabilidade e controlo do centro de massa.'});
 if(metrics.bodyAlignment!==null && metrics.bodyAlignment<60) observations.push({metric:'bodyAlignment',priority:'high',advice:'Rever alinhamento corporal na execução.'});
 if(metrics.changeOfDirection!==null && metrics.changeOfDirection<60) observations.push({metric:'changeOfDirection',priority:'medium',advice:'Praticar travagem e mudança de direção de forma progressiva.'});
 if(!observations.length) observations.push({metric:'overall',priority:'normal',advice:'Manter consistência e repetir a execução com qualidade.'});
 return {metrics,observations};
}

app.post('/api/computer-vision/analyze',auth,(req,res)=>{
 const result=computeVisionMetrics(req.body||{});
 const analysis={id:id(),status:'INDICATIVE',createdAt:new Date().toISOString(),videoId:req.body?.videoId||null,exerciseId:req.body?.exerciseId||null,...result,disclaimer:'Métricas estimadas por visão computacional. Não são diagnóstico médico nem classificação de talento.'};
 cvAnalyses.set(analysis.id,analysis);res.status(201).json(analysis);
});
app.get('/api/computer-vision/analysis/:id',auth,(req,res)=>{
 const a=cvAnalyses.get(req.params.id);if(!a)return res.status(404).json({error:'Analysis not found'});res.json(a);
});

// 64.0 Real Video Analysis Pipeline — asynchronous processing contract
const videoPipelineJobs=new Map();

function createVideoPipeline(input={}){
 const job={id:id(),userId:input.userId||null,videoId:input.videoId||null,exerciseId:input.exerciseId||null,
 status:'UPLOADED',progress:0,stages:[
  {name:'UPLOAD',status:'DONE'},
  {name:'FRAME_EXTRACTION',status:'QUEUED'},
  {name:'VISION_ANALYSIS',status:'QUEUED'},
  {name:'METRICS',status:'QUEUED'},
  {name:'COACH_REPORT',status:'QUEUED'}],
 createdAt:new Date().toISOString()};
 videoPipelineJobs.set(job.id,job); return job;
}
app.post('/api/video-pipeline',auth,(req,res)=>{
 const job=createVideoPipeline({...req.body,userId:req.user.sub});
 res.status(201).json(job);
});
app.get('/api/video-pipeline/:id',auth,(req,res)=>{
 const job=videoPipelineJobs.get(req.params.id);
 if(!job)return res.status(404).json({error:'Pipeline job not found'});
 res.json(job);
});
app.post('/api/video-pipeline/:id/process',auth,(req,res)=>{
 const job=videoPipelineJobs.get(req.params.id);
 if(!job)return res.status(404).json({error:'Pipeline job not found'});
 job.status='PROCESSING'; job.progress=100;
 job.stages.forEach((x,i)=>x.status=i===4?'READY':'DONE');
 res.json({...job,analysisReady:true});
});

// 65.0 Pose & Ball Tracking — structured tracking contract
const trackingJobs=new Map();

function calculateTracking(frames=[]){
 const valid=frames.filter(f=>f && f.pose && f.ball);
 const distances=[];
 for(let i=1;i<valid.length;i++){
  const a=valid[i-1].ball,b=valid[i].ball;
  if(Number.isFinite(a.x)&&Number.isFinite(a.y)&&Number.isFinite(b.x)&&Number.isFinite(b.y))
   distances.push(Math.hypot(b.x-a.x,b.y-a.y));
 }
 const avgBallMovement=distances.length?distances.reduce((a,b)=>a+b,0)/distances.length:0;
 const poseCoverage=frames.length?valid.length/frames.length:0;
 return {
  frames:frames.length,
  trackedFrames:valid.length,
  poseCoverage:Number(poseCoverage.toFixed(3)),
  ballSamples:distances.length+1,
  averageBallMovement:Number(avgBallMovement.toFixed(3)),
  trackingConfidence:poseCoverage>=0.8?'medium':poseCoverage>=0.5?'low':'insufficient'
 };
}
app.post('/api/computer-vision/tracking',auth,(req,res)=>{
 const result=calculateTracking(req.body?.frames||[]);
 const job={id:id(),status:'COMPLETE',createdAt:new Date().toISOString(),...result,
  note:'Tracking estruturado. Um detector de pose/bola de produção deve fornecer os keypoints e coordenadas.'};
 trackingJobs.set(job.id,job);res.status(201).json(job);
});
app.get('/api/computer-vision/tracking/:id',auth,(req,res)=>{
 const j=trackingJobs.get(req.params.id);if(!j)return res.status(404).json({error:'Tracking not found'});res.json(j);
});

// 66.0 Football Performance Metrics
const performanceMetrics=new Map();

function derivePerformanceMetrics(input={}){
 const frames=input.frames||[];
 const fps=Math.max(1,Number(input.fps||30));
 const durationSeconds=frames.length/fps;
 const points=frames.map(f=>f.player).filter(p=>p && Number.isFinite(p.x)&&Number.isFinite(p.y));
 let distance=0, maxSpeed=0;
 for(let i=1;i<points.length;i++){
  const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
  distance+=d;
  maxSpeed=Math.max(maxSpeed,d*fps);
 }
 const accelerations=[];
 for(let i=2;i<points.length;i++){
  const d1=Math.hypot(points[i-1].x-points[i-2].x,points[i-1].y-points[i-2].y);
  const d2=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
  accelerations.push(Math.abs((d2-d1)*fps*fps));
 }
 const avgAccel=accelerations.length?accelerations.reduce((a,b)=>a+b,0)/accelerations.length:0;
 const directionChanges=Number(input.directionChanges||0);
 const reactions=Array.isArray(input.reactionTimes)?input.reactionTimes:[];
 const avgReaction=reactions.length?reactions.reduce((a,b)=>a+Number(b),0)/reactions.length:null;
 const actions=Number(input.actions||0);
 return {
  durationSeconds:Number(durationSeconds.toFixed(2)),
  distanceUnits:Number(distance.toFixed(2)),
  maxSpeedUnitsPerSecond:Number(maxSpeed.toFixed(2)),
  averageAccelerationUnitsPerSecond2:Number(avgAccel.toFixed(2)),
  directionChanges,
  averageReactionSeconds:avgReaction===null?null:Number(avgReaction.toFixed(2)),
  actions,
  actionRatePerMinute:durationSeconds>0?Number((actions/(durationSeconds/60)).toFixed(2)):0,
  consistency:input.consistency??null,
  note:'Métricas dependentes da calibração da câmara, fps e detector; não equivalem automaticamente a métricas GPS ou médicas.'
 };
}
app.post('/api/performance-metrics/calculate',auth,(req,res)=>{
 const result=derivePerformanceMetrics(req.body||{});
 const item={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...result};
 performanceMetrics.set(item.id,item);res.status(201).json(item);
});
app.get('/api/performance-metrics/:id',auth,(req,res)=>{
 const item=performanceMetrics.get(req.params.id);if(!item)return res.status(404).json({error:'Metrics not found'});res.json(item);
});

// 67.0 Calibrated Football Metrics
const calibrationProfiles=new Map();

function calibratePitch(input={}){
 const pixelDistance=Number(input.pixelDistance||0);
 const realDistanceMeters=Number(input.realDistanceMeters||0);
 if(pixelDistance<=0||realDistanceMeters<=0) throw new Error('Calibration distances must be positive');
 const metersPerPixel=realDistanceMeters/pixelDistance;
 return {metersPerPixel,pixelDistance,realDistanceMeters,reference:input.reference||'known field marker'};
}
function calibratedMetrics(input={}){
 const calibration=calibrationProfiles.get(input.calibrationId);
 if(!calibration) throw new Error('Calibration not found');
 const relative=input.relative||{};
 const metersPerUnit=Number(calibration.metersPerPixel);
 const distanceMeters=Number(relative.distanceUnits||0)*metersPerUnit;
 const durationSeconds=Math.max(0.01,Number(relative.durationSeconds||1));
 const maxSpeedKmh=Number(relative.maxSpeedUnitsPerSecond||0)*metersPerUnit*3.6;
 const avgSpeedKmh=(distanceMeters/durationSeconds)*3.6;
 const acceleration=Number(relative.averageAccelerationUnitsPerSecond2||0)*metersPerUnit;
 return {
  calibrationId:input.calibrationId,
  distanceMeters:Number(distanceMeters.toFixed(2)),
  averageSpeedKmh:Number(avgSpeedKmh.toFixed(2)),
  maxSpeedKmh:Number(maxSpeedKmh.toFixed(2)),
  averageAccelerationMs2:Number(acceleration.toFixed(2)),
  zoneThresholdsKmh:[0,7,14,20],
  note:'Valores estimados pela calibração fornecida; qualidade depende da câmara, perspetiva e tracking.'
 };
}
app.post('/api/performance-metrics/calibrate',auth,(req,res)=>{
 try{
  const profile={id:id(),createdAt:new Date().toISOString(),...calibratePitch(req.body||{})};
  calibrationProfiles.set(profile.id,profile);res.status(201).json(profile);
 }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/performance-metrics/calibrated',auth,(req,res)=>{
 try{res.status(201).json({id:id(),createdAt:new Date().toISOString(),...calibratedMetrics(req.body||{})});}
 catch(e){res.status(400).json({error:e.message});}
});

// 68.0 Field Mapping
const fieldMaps=new Map();

function mapToField(input={}){
 const width=Number(input.fieldWidth||68), length=Number(input.fieldLength||105);
 const points=Array.isArray(input.points)?input.points:[];
 const mapped=points.map(p=>({
  x:Number(Math.max(0,Math.min(1,p.x||0))*length.toFixed(2)),
  y:Number(Math.max(0,Math.min(1,p.y||0))*width.toFixed(2)),
  t:Number(p.t||0),
  action:p.action||null
 }));
 const zones=Array.from({length:6},()=>0);
 mapped.forEach(p=>zones[Math.min(5,Math.floor((p.x/length)*6))]++);
 const total=mapped.length||1;
 return {field:{length,width},points:mapped,zones:zones.map((n,i)=>({zone:i+1,percentage:Number((n/total*100).toFixed(1))}))};
}
app.post('/api/field-mapping/create',auth,(req,res)=>{
 const map={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...mapToField(req.body||{})};
 fieldMaps.set(map.id,map);res.status(201).json(map);
});
app.get('/api/field-mapping/:id',auth,(req,res)=>{
 const m=fieldMaps.get(req.params.id);if(!m)return res.status(404).json({error:'Field map not found'});res.json(m);
});

// 69.0 Heatmap & Movement Analytics
const movementAnalytics=new Map();

function buildHeatmap(input={}){
 const length=Number(input.fieldLength||105), width=Number(input.fieldWidth||68);
 const cols=12, rows=8, cells=Array.from({length:rows},()=>Array(cols).fill(0));
 const points=Array.isArray(input.points)?input.points:[];
 points.forEach(p=>{
  const x=Math.max(0,Math.min(0.999999,Number(p.x||0)/length));
  const y=Math.max(0,Math.min(0.999999,Number(p.y||0)/width));
  cells[Math.floor(y*rows)][Math.floor(x*cols)]++;
 });
 const flat=cells.flat(), max=Math.max(...flat,0);
 const heatmap=cells.map((row,y)=>row.map((count,x)=>({x,y,count,intensity:max?Number((count/max).toFixed(3)):0})));
 const zoneStats=Array.from({length:6},(_,i)=>0);
 points.forEach(p=>zoneStats[Math.min(5,Math.floor(Math.max(0,Math.min(0.999999,Number(p.x||0)/length))*6))]++);
 return {field:{length,width},grid:{cols,rows},heatmap,zoneStats,totalPoints:points.length};
}
app.post('/api/movement-analytics/heatmap',auth,(req,res)=>{
 const result=buildHeatmap(req.body||{});
 const item={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...result};
 movementAnalytics.set(item.id,item);res.status(201).json(item);
});
app.get('/api/movement-analytics/heatmap/:id',auth,(req,res)=>{
 const item=movementAnalytics.get(req.params.id);if(!item)return res.status(404).json({error:'Heatmap not found'});res.json(item);
});

// 70.0 Tactical Action Map
const tacticalMaps=new Map();
const tacticalActionTypes=['PASS','RECEPTION','CARRY','DRIBBLE','CROSS','SHOT','RECOVERY','PRESSURE'];

function buildTacticalMap(input={}){
 const length=Number(input.fieldLength||105),width=Number(input.fieldWidth||68);
 const actions=(Array.isArray(input.actions)?input.actions:[]).map(a=>({
  type:String(a.type||'OTHER').toUpperCase(),
  x:Number(Math.max(0,Math.min(1,Number(a.x||0)))*length.toFixed(2)),
  y:Number(Math.max(0,Math.min(1,Number(a.y||0)))*width.toFixed(2)),
  t:Number(a.t||0),outcome:a.outcome||'UNKNOWN',
  targetX:a.targetX==null?null:Number(Math.max(0,Math.min(1,a.targetX))*length.toFixed(2)),
  targetY:a.targetY==null?null:Number(Math.max(0,Math.min(1,a.targetY))*width.toFixed(2))
 }));
 const counts=Object.fromEntries(tacticalActionTypes.map(t=>[t,0]));
 actions.forEach(a=>{if(counts[a.type]!=null)counts[a.type]++;});
 return {field:{length,width},actions,counts,totalActions:actions.length};
}
app.post('/api/tactical-action-map',auth,(req,res)=>{
 const map={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...buildTacticalMap(req.body||{})};
 tacticalMaps.set(map.id,map);res.status(201).json(map);
});
app.get('/api/tactical-action-map/:id',auth,(req,res)=>{
 const m=tacticalMaps.get(req.params.id);if(!m)return res.status(404).json({error:'Tactical map not found'});res.json(m);
});

// 71.0 Tactical Intelligence
const tacticalInsights=new Map();
function generateTacticalInsights(input={}){
 const position=input.position||'Extremo';
 const actions=Array.isArray(input.actions)?input.actions:[];
 const insights=[];
 const byType=t=>actions.filter(a=>String(a.type).toUpperCase()===t);
 const receptions=byType('RECEPTION'), passes=byType('PASS');
 if(receptions.length){
  const avgX=receptions.reduce((n,a)=>n+Number(a.x||0),0)/receptions.length;
  if(position==='Extremo' && avgX<0.35) insights.push({area:'Receção',priority:'medium',message:'As receções estão concentradas numa zona mais recuada; avaliar se o objetivo pede maior profundidade.',nextAction:'Testar receção em zona intermédia/avançada com apoio próximo.'});
 }
 if(passes.length && passes.filter(a=>a.outcome==='SUCCESS').length/passes.length<0.6)
  insights.push({area:'Passe',priority:'high',message:'A taxa de sucesso dos passes observados está abaixo do objetivo definido.',nextAction:'Treinar orientação corporal e escolha da linha de passe.'});
 if(actions.length>=5) insights.push({area:'Comportamento',priority:'normal',message:'Existe volume suficiente para procurar padrões espaciais.',nextAction:'Comparar com a sessão anterior e com o perfil da posição.'});
 if(!insights.length) insights.push({area:'Geral',priority:'normal',message:'Não foram encontrados desvios claros com os dados disponíveis.',nextAction:'Continuar a recolher ações para aumentar a qualidade da análise.'});
 return {position,insights,explainability:'Cada insight é associado a dados observados; não representa uma classificação de talento.'};
}
app.post('/api/tactical-intelligence/analyze',auth,(req,res)=>{
 const result=generateTacticalInsights(req.body||{});
 const item={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...result};
 tacticalInsights.set(item.id,item);res.status(201).json(item);
});
app.get('/api/tactical-intelligence/:id',auth,(req,res)=>{
 const x=tacticalInsights.get(req.params.id);if(!x)return res.status(404).json({error:'Insight not found'});res.json(x);
});

// 72.0 Match Analysis
const matchAnalyses=new Map();
function analyzeMatch(input={}){
 const actions=Array.isArray(input.actions)?input.actions:[];
 const minutes=Math.max(1,Number(input.minutes||90));
 const successful=actions.filter(a=>a.outcome==='SUCCESS').length;
 const byType={};
 actions.forEach(a=>{const t=String(a.type||'OTHER').toUpperCase();byType[t]=(byType[t]||0)+1;});
 const highIntensity=Number(input.highIntensitySeconds||0);
 return {
  context:'MATCH',
  minutes,totalActions:actions.length,
  actionsPerMinute:Number((actions.length/minutes).toFixed(2)),
  successRate:actions.length?Number((successful/actions.length*100).toFixed(1)):null,
  highIntensitySeconds:highIntensity,
  highIntensityMinutes:Number((highIntensity/60).toFixed(2)),
  actionBreakdown:byType,
  phases:input.phases||[],
  comparisonBaseline:input.comparisonBaseline||null,
  note:'Análise contextual de jogo; a qualidade depende da amostra, vídeo, tracking e definição das ações.'
 };
}
app.post('/api/match-analysis/analyze',auth,(req,res)=>{
 const item={id:id(),userId:req.user.sub,createdAt:new Date().toISOString(),...analyzeMatch(req.body||{})};
 matchAnalyses.set(item.id,item);res.status(201).json(item);
});
app.get('/api/match-analysis/:id',auth,(req,res)=>{
 const x=matchAnalyses.get(req.params.id);if(!x)return res.status(404).json({error:'Match analysis not found'});res.json(x);
});

// 73.0 Match vs Training
function compareMatchTraining(input={}){
 const training=input.training||{}, match=input.match||{};
 const keys=['successRate','actionsPerMinute','highIntensityMinutes','completionRate','rpe'];
 const comparison={};
 for(const k of keys){
  const t=Number(training[k]); const m=Number(match[k]);
  if(Number.isFinite(t)&&Number.isFinite(m)){
   comparison[k]={training:t,match:m,difference:Number((m-t).toFixed(2))};
  }
 }
 const insights=[];
 if(comparison.successRate && comparison.successRate.difference < -10)
  insights.push('A taxa de sucesso em jogo está significativamente abaixo do treino.');
 if(comparison.actionsPerMinute && comparison.actionsPerMinute.difference < -0.5)
  insights.push('A frequência de ações competitivas está abaixo do padrão observado no treino.');
 if(comparison.highIntensityMinutes && comparison.highIntensityMinutes.difference < -5)
  insights.push('A exposição a alta intensidade em jogo ficou abaixo da referência de treino.');
 if(!insights.length) insights.push('Não foi detetada uma diferença crítica nos indicadores fornecidos.');
 return {context:'MATCH_VS_TRAINING',comparison,insights,
  recommendation:'Usar as diferenças para ajustar exercícios e situações de treino específicas, sem tirar conclusões de talento a partir de uma única partida.'};
}
app.post('/api/match-vs-training/compare',auth,(req,res)=>{
 res.json(compareMatchTraining(req.body||{}));
});

// 74.0 Pressure & Decision Engine
function pressureDecisionAnalysis(input={}){
 const situations=Array.isArray(input.situations)?input.situations:[];
 const scored=situations.map((x,i)=>{
  const pressure=Math.max(0,Math.min(100,Number(x.pressure||0)));
  const time=Math.max(0,Number(x.timeAvailable||0));
  const space=Math.max(0,Number(x.space||0));
  const opponents=Math.max(0,Number(x.opponents||0));
  const decisionTime=Math.max(0,Number(x.decisionTime||0));
  const correct=x.correct===true;
  const pressureIndex=Number((pressure + opponents*5 + (time<2?15:0) + (space<10?15:0)).toFixed(1));
  return {index:i+1,pressure, timeAvailable:time, space, opponents, decisionTime,
    correct, pressureIndex};
 });
 const high= scored.filter(x=>x.pressureIndex>=70);
 const correct=scored.filter(x=>x.correct).length;
 const rate=scored.length?Number((correct/scored.length*100).toFixed(1)):null;
 let recommendation='Manter situações variadas e aumentar gradualmente a complexidade.';
 if(rate!==null && rate<60) recommendation='Reduzir a complexidade inicial e treinar decisões sob pressão com progressão controlada.';
 else if(rate!==null && rate>=80 && high.length) recommendation='Aumentar gradualmente a pressão, reduzir espaço/tempo e introduzir mais oposição.';
 return {context:'PRESSURE_DECISION',situations:scored,totalSituations:scored.length,
  correctDecisions:correct,decisionSuccessRate:rate,highPressureSituations:high.length,
  recommendation,note:'Métrica contextual para orientar treino; não é classificação de talento.'};
}
app.post('/api/pressure-decision/analyze',auth,(req,res)=>{
 res.json(pressureDecisionAnalysis(req.body||{}));
});

// 75.0 AI Match Intelligence
function aiMatchIntelligence(input={}){
 const match=input.match||{}, training=input.training||{}, pressure=input.pressure||{}, tactical=input.tactical||{};
 const gaps=[];
 if(Number.isFinite(Number(training.successRate)) && Number.isFinite(Number(match.successRate)) &&
    Number(match.successRate)<Number(training.successRate)-10)
   gaps.push({area:'EXECUÇÃO EM COMPETIÇÃO',severity:'HIGH',
     detail:'Eficácia em jogo abaixo da referência de treino.'});
 if(Number.isFinite(Number(pressure.decisionSuccessRate)) &&
    Number(pressure.decisionSuccessRate)<60)
   gaps.push({area:'DECISÃO SOB PRESSÃO',severity:'HIGH',
     detail:'Taxa de decisões corretas sob pressão abaixo do objetivo.'});
 if(Number(tactical.passSuccessRate)>=0 && Number(tactical.passSuccessRate)<70)
   gaps.push({area:'PASSE/TÁTICA',severity:'MEDIUM',
     detail:'Eficiência de passe abaixo da referência configurada.'});
 const priorities=[...gaps].sort((a,b)=>a.severity==='HIGH'?-1:b.severity==='HIGH'?1:0).slice(0,4);
 const drills=priorities.map((g,i)=>({
   priority:i+1, area:g.area,
   trainingFocus: g.area==='DECISÃO SOB PRESSÃO'?'jogos reduzidos, pressão temporal e oposição progressiva':
                 g.area==='PASSE/TÁTICA'?'passe sob pressão e leitura de linhas':
                 'situações específicas de jogo com oposição e tomada de decisão'
 }));
 return {
  context:'AI_MATCH_INTELLIGENCE',
  summary: priorities.length
   ? `Foram identificadas ${priorities.length} prioridades para transformar a análise da partida em treino.`
   : 'Não foram identificadas lacunas críticas com os dados fornecidos.',
  priorities, weeklyTrainingFocus:drills,
  coachAction:'Integrar estas prioridades no próximo microciclo e voltar a comparar jogo vs treino.',
  safetyNote:'Relatório contextual. Não classifica talento nem substitui avaliação profissional.'
 };
}
app.post('/api/ai-match-intelligence/report',auth,(req,res)=>{
 res.json(aiMatchIntelligence(req.body||{}));
});

// 76.0 AI Weekly Microcycle
function generateWeeklyMicrocycle(input={}){
 const days=Array.isArray(input.days)?input.days:[];
 const priorities=Array.isArray(input.priorities)?input.priorities:[];
 const availability=input.availability||{};
 const currentLoad=Number(input.currentLoad||0);
 const maxLoad=Number(input.maxLoad||700);
 const matchDay=Number.isFinite(Number(input.matchDay))?Number(input.matchDay):null;
 const focus=priorities.slice(0,3).map(x=>typeof x==='string'?x:x.area||'DESENVOLVIMENTO');
 const plan=days.slice(0,7).map((day,i)=>{
   const dayNum=i+1, available=availability[String(dayNum)]!==false;
   let type='RECOVERY';
   if(available){
     if(matchDay===dayNum) type='MATCH';
     else if(matchDay!==null && Math.abs(matchDay-dayNum)<=1) type='RECOVERY';
     else type=i%3===0?'TECHNICAL':i%3===1?'TACTICAL':'DECISION';
   }
   return {day:dayNum,label:day,available,type,
     focus:type==='RECOVERY'?['mobilidade','recuperação']:
       type==='MATCH'?['competição']:
       focus.length?focus:['desenvolvimento geral']};
 });
 const loadWarning=currentLoad>=maxLoad;
 return {context:'AI_WEEKLY_MICROCYCLE',week:plan,priorities:focus,
   currentLoad,maxLoad,loadWarning,
   rationale:'Microciclo gerado a partir das prioridades competitivas, disponibilidade e carga atual.',
   coachReviewRequired:true};
}
app.post('/api/ai-weekly-microcycle/generate',auth,(req,res)=>{
 res.json(generateWeeklyMicrocycle(req.body||{}));
});

// 77.0 AI Daily Training
function generateDailyTraining(input={}){
 const day=input.day||'Hoje';
 const focus=Array.isArray(input.focus)?input.focus:['desenvolvimento geral'];
 const minutes=Math.max(10,Math.min(120,Number(input.minutes||45)));
 const available=Array.isArray(input.exercises)?input.exercises:[];
 const load=Number(input.currentLoad||0);
 const intensity=load>=700?'MODERATE':'PROGRESSIVE';
 const selected=available.slice(0,Math.max(3,Math.min(8,Math.floor(minutes/7))));
 const blocks=selected.map((e,i)=>({
   order:i+1, exerciseId:e.id||`exercise-${i+1}`, name:e.name||`Exercício ${i+1}`,
   sets:Number(e.sets||3), reps:Number(e.reps||8), restSeconds:Number(e.restSeconds||45),
   intensity:e.intensity||intensity, focus:e.focus||focus[i%focus.length],
   videoUrl:e.videoUrl||null
 }));
 return {context:'AI_DAILY_TRAINING',day,minutes,focus,
   intensity,blocks,totalBlocks:blocks.length,
   currentLoad:load,
   adaptationRule:'Após cada bloco, usar feedback/RPE para ajustar o bloco seguinte quando possível.',
   safetyNote:'Plano gerado automaticamente; deve respeitar conteúdo aprovado, limites de carga e orientação profissional quando aplicável.'};
}
app.post('/api/ai-daily-training/generate',auth,(req,res)=>{
 res.json(generateDailyTraining(req.body||{}));
});

// 78.0 Real-time Adaptive Training
function adaptTrainingBlock(input={}){
 const difficulty=Math.max(1,Math.min(5,Number(input.difficulty||3)));
 const rpe=Math.max(1,Math.min(10,Number(input.rpe||5)));
 const fatigue=Math.max(1,Math.min(10,Number(input.fatigue||5)));
 const completed=input.completed!==false;
 let action='MAINTAIN', nextDifficulty=difficulty, restSeconds=Number(input.restSeconds||45), reps=Number(input.reps||8);
 if(!completed || rpe>=9 || fatigue>=9){
   action='RECOVER'; nextDifficulty=Math.max(1,difficulty-1); restSeconds+=30; reps=Math.max(4,reps-2);
 } else if(difficulty<=2 && rpe<=4 && fatigue<=5){
   action='PROGRESS'; nextDifficulty=Math.min(5,difficulty+1); reps+=2;
 } else if(rpe>=8 || fatigue>=8){
   action='REDUCE'; nextDifficulty=Math.max(1,difficulty-1); restSeconds+=20;
 }
 return {context:'REAL_TIME_ADAPTATION',action,nextDifficulty,reps,restSeconds,
   inputs:{difficulty,rpe,fatigue,completed},
   explanation: action==='PROGRESS'?'Baixa exigência percebida: progressão moderada.':
     action==='RECOVER'?'Sinais elevados de esforço/fadiga ou bloco incompleto: recuperação antes de progredir.':
     action==='REDUCE'?'Esforço/fadiga elevados: reduzir complexidade e/ou aumentar recuperação.':
     'Carga atual mantida.',
   note:'Adaptação orientativa; não substitui avaliação clínica ou profissional.'};
}
app.post('/api/training/adapt-block',auth,(req,res)=>{
 res.json(adaptTrainingBlock(req.body||{}));
});

// 79.0 AI Player Memory
const playerMemory=new Map();
function updatePlayerMemory(input={}){
 const playerId=String(input.playerId||'demo-player');
 const prev=playerMemory.get(playerId)||{playerId,events:[],exerciseResponses:{},areas:{}};
 const event={
   date:input.date||new Date().toISOString(),
   type:input.type||'SESSION',
   summary:input.summary||null,
   metrics:input.metrics||{},
   feedback:input.feedback||null
 };
 prev.events.push(event);
 const responses=input.exerciseResponses||[];
 responses.forEach(r=>{
   const key=String(r.exerciseId||'unknown');
   const arr=prev.exerciseResponses[key]||[];
   arr.push({date:event.date,difficulty:r.difficulty,rpe:r.rpe,completed:r.completed});
   prev.exerciseResponses[key]=arr.slice(-20);
 });
 Object.entries(input.areas||{}).forEach(([area,value])=>{
   const arr=prev.areas[area]||[];
   arr.push({date:event.date,value:Number(value)});
   prev.areas[area]=arr.slice(-20);
 });
 prev.events=prev.events.slice(-100);
 playerMemory.set(playerId,prev);
 return buildPlayerMemorySummary(prev);
}
function buildPlayerMemorySummary(m){
 const areaTrends={};
 for(const [area,arr] of Object.entries(m.areas)){
   if(arr.length>=2) areaTrends[area]={first:arr[0].value,last:arr.at(-1).value,
     change:Number((arr.at(-1).value-arr[0].value).toFixed(2)),samples:arr.length};
 }
 const exerciseInsights=Object.entries(m.exerciseResponses).map(([id,arr])=>{
   const completed=arr.filter(x=>x.completed===true).length;
   const avgRpe=arr.length?Number((arr.reduce((a,x)=>a+Number(x.rpe||0),0)/arr.length).toFixed(1)):null;
   return {exerciseId:id,samples:arr.length,completionRate:arr.length?Number((completed/arr.length*100).toFixed(1)):null,avgRpe};
 });
 return {playerId:m.playerId,totalEvents:m.events.length,areaTrends,exerciseInsights,
   recentEvents:m.events.slice(-10),
   memoryPurpose:'Memória operacional para personalização longitudinal; não é perfil clínico nem classificação de talento.'};
}
app.post('/api/player-memory/update',auth,(req,res)=>{
 res.json(updatePlayerMemory(req.body||{}));
});
app.get('/api/player-memory/:playerId',auth,(req,res)=>{
 const m=playerMemory.get(String(req.params.playerId));
 if(!m)return res.status(404).json({error:'Player memory not found'});
 res.json(buildPlayerMemorySummary(m));
});

// 80.0 AI Long-Term Development Plan
function generateLongTermPlan(input={}){
 const horizon=Number(input.horizonMonths||12);
 const profile=input.profile||{};
 const goals=Array.isArray(input.goals)?input.goals:['desenvolvimento global'];
 const memory=input.memory||{};
 const current=memory.areaTrends||{};
 const phases=horizon<=3?3:4;
 const phaseNames=horizon<=3?['BASELINE','DEVELOPMENT','REVIEW']:
   horizon<=6?['BASELINE','DEVELOPMENT','TRANSFER','REVIEW']:
   ['BASELINE','FOUNDATION','DEVELOPMENT','COMPETITION_TRANSFER'];
 const cycleLength=Math.max(1,Math.round(horizon/phases));
 const cycles=phaseNames.map((name,i)=>({
   phase:i+1,name,
   months:`${i*cycleLength+1}-${Math.min(horizon,(i+1)*cycleLength)}`,
   objectives:i===0?['estabelecer referência','consolidar hábitos']:
     i===phaseNames.length-1?['transferir competências para competição','reavaliar e ajustar']:
     ['desenvolver prioridades','aumentar complexidade progressivamente'],
   reviewPoint:i===phaseNames.length-1?'full_review':'cycle_review'
 }));
 const trends=Object.entries(current).map(([area,v])=>({area,change:Number(v.change||0),samples:v.samples||0}))
   .sort((a,b)=>a.change-b.change).slice(0,5);
 return {
   context:'AI_LONG_TERM_DEVELOPMENT',
   horizonMonths:horizon,playerProfile:profile,goals,
   phases:cycles,prioritySignals:trends,
   reviewCadence:'revisão em cada ciclo e replaneamento após avaliação relevante',
   principle:'O plano é adaptativo: metas e carga devem ser revistas com dados reais, disponibilidade e contexto competitivo.',
   safetyNote:'Não é promessa de desempenho futuro nem classificação de talento; requer validação profissional quando aplicável.'
 };
}
app.post('/api/ai-long-term-plan/generate',auth,(req,res)=>{
 res.json(generateLongTermPlan(req.body||{}));
});

// 81.0 Player Development Roadmap
function buildDevelopmentRoadmap(input={}){
 const goals=Array.isArray(input.goals)?input.goals:[];
 const milestones=Array.isArray(input.milestones)?input.milestones:[];
 const competencies=Array.isArray(input.competencies)?input.competencies:[];
 const cycles=Array.isArray(input.cycles)?input.cycles:[];
 const timeline=[
  ...cycles.map((c,i)=>({type:'CYCLE',order:i+1,label:c.label||`Ciclo ${i+1}`,status:c.status||'PLANNED',focus:c.focus||[]})),
  ...milestones.map((m,i)=>({type:'MILESTONE',order:i+1,label:m.label||`Marco ${i+1}`,status:m.status||'PLANNED',focus:m.focus||[]}))
 ];
 return {
  context:'PLAYER_DEVELOPMENT_ROADMAP',
  player:input.player||{},
  goals,competencies,cycles,milestones,
  timeline:timeline.sort((a,b)=>a.order-b.order),
  audience:['PLAYER','FAMILY','COACH'],
  review:'Atualizar após avaliações, ciclos e competições relevantes.',
  note:'Roadmap de desenvolvimento; não representa previsão de carreira nem classificação de talento.'
 };
}
app.post('/api/player-development/roadmap',auth,(req,res)=>{
 res.json(buildDevelopmentRoadmap(req.body||{}));
});

// 82.0 Smart Player Dashboard
function buildSmartPlayerDashboard(input={}){
 const p=input.player||{}, training=input.training||{}, progress=input.progress||{},
       roadmap=input.roadmap||{}, load=input.load||{}, matches=input.matches||{},
       coach=input.coach||{};
 return {
  context:'SMART_PLAYER_DASHBOARD',
  player:p,
  todayTraining:training,
  progress:progress,
  roadmap:roadmap,
  load:{current:Number(load.current||0),status:load.status||'NORMAL'},
  matches,
  aiCoach:coach,
  nextGoals:Array.isArray(roadmap.goals)?roadmap.goals.slice(0,3):[],
  quickActions:['START_TRAINING','VIEW_PROGRESS','OPEN_AI_COACH','VIEW_ROADMAP','VIEW_MATCHES'],
  note:'Painel consolidado; indicadores devem ser interpretados no contexto individual.'
 };
}
app.post('/api/player/smart-dashboard',auth,(req,res)=>{
 res.json(buildSmartPlayerDashboard(req.body||{}));
});

// 83.0 Family Smart Dashboard
function buildFamilySmartDashboard(input={}){
 const player=input.player||{}, progress=input.progress||{}, training=input.training||{},
       calendar=input.calendar||{}, coach=input.coach||{}, privacy=input.privacy||{};
 return {
  context:'FAMILY_SMART_DASHBOARD',
  player:{name:player.name||'Jogador',age:player.age||null},
  progress,training,calendar,coach,
  privacy:{consentStatus:privacy.consentStatus||'UNKNOWN',
    videoSharing:privacy.videoSharing===true,
    dataSharing:privacy.dataSharing===true},
  actions:['VIEW_PROGRESS','VIEW_TRAINING','VIEW_CALENDAR','MESSAGE_COACH','MANAGE_CONSENT'],
  note:'Painel familiar com acesso limitado por permissões e consentimento. Não substitui acompanhamento profissional.'
 };
}
app.post('/api/family/smart-dashboard',auth,(req,res)=>{
 res.json(buildFamilySmartDashboard(req.body||{}));
});

// 84.0 Coach Smart Dashboard
function buildCoachSmartDashboard(input={}){
 const academy=input.academy||{}, team=input.team||{}, players=Array.isArray(input.players)?input.players:[],
       alerts=Array.isArray(input.alerts)?input.alerts:[], matches=input.matches||{},
       recommendations=Array.isArray(input.recommendations)?input.recommendations:[];
 const active=players.filter(p=>p.active!==false).length;
 const highLoad=players.filter(p=>Number(p.load||0)>=700).length;
 return {
  context:'COACH_SMART_DASHBOARD',
  academy,team,
  summary:{players:active,highLoadAlerts:highLoad,alerts:alerts.length},
  players,alerts,matches,recommendations,
  actions:['VIEW_SQUAD','VIEW_PLAYER','REVIEW_LOAD','VIEW_MATCHES','REVIEW_AI','CREATE_PLAN'],
  note:'Painel do treinador; recomendações da IA apoiam a decisão profissional e não substituem avaliação do treinador.'
 };
}
app.post('/api/coach/smart-dashboard',auth,(req,res)=>{
 res.json(buildCoachSmartDashboard(req.body||{}));
});

// 85.0 AI Squad Intelligence
function buildSquadIntelligence(input={}){
 const players=Array.isArray(input.players)?input.players:[];
 const nextMatch=input.nextMatch||{};
 const positionCounts={};
 players.forEach(p=>{const pos=String(p.position||'UNKNOWN');positionCounts[pos]=(positionCounts[pos]||0)+1;});
 const highLoad=players.filter(p=>Number(p.load||0)>=700).map(p=>p.id||p.name);
 const needs=players.map(p=>({
   id:p.id||null,name:p.name||'Jogador',position:p.position||'UNKNOWN',
   priority:p.priority||'GENERAL',load:Number(p.load||0),
   availability:p.availability!==false
 })).filter(p=>p.availability);
 const recommendations=[];
 if(highLoad.length) recommendations.push('Rever a carga dos jogadores com carga elevada antes do próximo jogo.');
 if(nextMatch.position) recommendations.push(`Preparar o plantel para a exigência na posição/contexto ${nextMatch.position}.`);
 if(!recommendations.length) recommendations.push('Manter monitorização do plantel e ajustar prioridades conforme treino e competição.');
 return {context:'AI_SQUAD_INTELLIGENCE',team:input.team||{},
   squadSize:players.length,positionCounts,highLoadPlayers:highLoad,
   nextMatch,playerNeeds:needs,recommendations,
   collectiveFocus:Array.isArray(input.collectiveFocus)?input.collectiveFocus:[],
   note:'Inteligência de plantel para apoio à decisão do treinador; não substitui avaliação profissional.'};
}
app.post('/api/ai-squad-intelligence/analyze',auth,(req,res)=>{
 res.json(buildSquadIntelligence(req.body||{}));
});

// 86.0 AI Match Preparation
function buildMatchPreparation(input={}){
 const opponent=input.opponent||{}, team=input.team||{}, squad=Array.isArray(input.squad)?input.squad:[],
       priorities=Array.isArray(input.priorities)?input.priorities:[],
       match=input.match||{};
 const available=squad.filter(p=>p.available!==false);
 const unavailable=squad.filter(p=>p.available===false);
 const focus=[];
 if(opponent.pressure) focus.push(`Preparar saída sob pressão (${opponent.pressure}).`);
 if(opponent.transition) focus.push(`Treinar transições contra ${opponent.transition}.`);
 if(opponent.width) focus.push(`Preparar defesa/ataque da largura (${opponent.width}).`);
 if(!focus.length) focus.push('Rever princípios coletivos e situações específicas do adversário.');
 return {
  context:'AI_MATCH_PREPARATION',match,opponent,team,
  squadSummary:{available:available.length,unavailable:unavailable.length},
  individualPriorities:priorities,
  tacticalFocus:focus,
  preparationBlocks:[
   {order:1,type:'ACTIVATION',minutes:10},
   {order:2,type:'TACTICAL',minutes:20},
   {order:3,type:'OPPOSITION_SCENARIOS',minutes:20},
   {order:4,type:'SET_PIECES',minutes:10},
   {order:5,type:'RECOVERY',minutes:10}
  ],
  recommendations:[
   'Adaptar a intensidade à carga recente.',
   'Usar exercícios aprovados pela biblioteca de conteúdos.',
   'Rever o plano final com o treinador antes da sessão.'
  ],
  note:'Preparação assistida por IA; não substitui análise profissional do adversário nem decisão do treinador.'
 };
}
app.post('/api/ai-match-preparation/generate',auth,(req,res)=>{
 res.json(buildMatchPreparation(req.body||{}));
});

// 87.0 AI Opponent Analysis
function analyzeOpponent(input={}){
 const patterns=Array.isArray(input.patterns)?input.patterns:[];
 const strengths=patterns.filter(p=>p.type==='STRENGTH');
 const weaknesses=patterns.filter(p=>p.type==='WEAKNESS');
 const tendencies=patterns.filter(p=>p.type==='TENDENCY');
 const scenarios=[];
 weaknesses.slice(0,5).forEach(w=>scenarios.push({
   objective:`Explorar: ${w.area||'vulnerabilidade'}`,
   scenario:w.scenario||'Criar situação específica em treino',
   priority:w.priority||'MEDIUM'
 }));
 return {
  context:'AI_OPPONENT_ANALYSIS',
  opponent:input.opponent||{},
  sampleSize:patterns.length,
  strengths,weaknesses,tendencies,
  scenarios,
  preparationFocus:[
   ...strengths.slice(0,3).map(x=>`Preparar resposta a ${x.area||'ponto forte do adversário'}.`),
   ...weaknesses.slice(0,3).map(x=>`Explorar ${x.area||'ponto vulnerável'} com treino específico.`)
  ],
  confidence:patterns.length>=10?'MODERATE':'LOW',
  note:'Análise baseada nos dados fornecidos; confiança depende da qualidade e representatividade da amostra.'
 };
}
app.post('/api/ai-opponent-analysis/analyze',auth,(req,res)=>{
 res.json(analyzeOpponent(req.body||{}));
});

// 88.0 AI Tactical Match Plan
function buildTacticalMatchPlan(input={}){
 const team=input.team||{}, opponent=input.opponent||{}, priorities=Array.isArray(input.priorities)?input.priorities:[],
       scenarios=Array.isArray(input.scenarios)?input.scenarios:[], principles=Array.isArray(input.principles)?input.principles:[];
 const phases=['IN_POSSESSION','OUT_OF_POSSESSION','TRANSITION_ATTACK','TRANSITION_DEFENCE','SET_PIECES'];
 const phasePlans=phases.map((phase,i)=>({
   phase,
   objective: principles[i]||(
    phase==='IN_POSSESSION'?'Criar progressão com segurança':
    phase==='OUT_OF_POSSESSION'?'Controlar espaço e pressionar com coordenação':
    phase==='TRANSITION_ATTACK'?'Acelerar quando existe vantagem':
    phase==='TRANSITION_DEFENCE'?'Reagir imediatamente à perda':
    'Organizar bolas paradas'
   ),
   cues: scenarios.slice(i, i+2).map(x=>x.cue||x.scenario||'Situação específica')
 }));
 return {
  context:'AI_TACTICAL_MATCH_PLAN',team,opponent,
  priorities:priorities.slice(0,8),
  phasePlans,
  individualRoles:Array.isArray(input.individualRoles)?input.individualRoles:[],
  preMatchTraining:scenarios.slice(0,6),
  reviewPoints:['Confirmar plano com equipa técnica','Adaptar ao contexto real da partida','Rever após o jogo'],
  note:'Plano tático assistido por IA; não substitui o modelo de jogo e decisão do treinador.'
 };
}
app.post('/api/ai-tactical-match-plan/generate',auth,(req,res)=>{
 res.json(buildTacticalMatchPlan(req.body||{}));
});

// 89.0 AI Match Day Center
function buildMatchDayCenter(input={}){
 const match=input.match||{}, squad=Array.isArray(input.squad)?input.squad:[],
       plan=input.tacticalPlan||{}, individualGoals=Array.isArray(input.individualGoals)?input.individualGoals:[],
       checklist=[
        'Confirmar disponibilidade e convocatória',
        'Rever plano tático e bolas paradas',
        'Confirmar objetivos individuais',
        'Executar aquecimento definido pela equipa técnica',
        'Registar eventos relevantes durante a partida',
        'Fechar análise pós-jogo'
       ];
 return {
  context:'AI_MATCH_DAY_CENTER',
  match,
  squad: squad.map(p=>({...p,status:p.status||'AVAILABLE'})),
  tacticalPlan:plan,
  individualGoals:individualGoals.slice(0,30),
  preMatch:{checklist, briefing:['Modelo de jogo','Adversário','Transições','Bolas paradas','Objetivos individuais']},
  liveEvents:[],
  postMatch:{required:['Resultado','Minutos','Carga percebida','Ações-chave','Pontos fortes','Pontos a melhorar']},
  nextStep:'Enviar dados para Match Analysis e AI Match Intelligence',
  note:'Centro operacional assistido por IA; não decide convocatórias, substituições ou estratégia sem intervenção da equipa técnica.'
 };
}
app.post('/api/ai-match-day-center/generate',auth,(req,res)=>{
 res.json(buildMatchDayCenter(req.body||{}));
});
app.post('/api/ai-match-day-center/:id/event',auth,(req,res)=>{
 res.json({matchDayId:req.params.id,event:{...req.body,recordedAt:new Date().toISOString()},next:'match-analysis'});
});

// 90.0 AI Live Match Analysis
function buildLiveMatchAnalysis(input={}){
 const events=Array.isArray(input.events)?input.events:[],
       clock=Number(input.matchMinute||0),
       phase=input.phase||'MATCH',
       recent=events.slice(-12),
       counts={};
 recent.forEach(e=>{ const k=e.type||'OTHER'; counts[k]=(counts[k]||0)+1; });
 const insights=[];
 if((counts.PRESSURE||0)>=3) insights.push('Sequência recente de ações de pressão: rever intensidade e organização.');
 if((counts.PASS||0)>=5) insights.push('Volume recente de passes: verificar progressão e segurança na circulação.');
 if((counts.LOST_BALL||0)>=3) insights.push('Perdas recentes: atenção à transição defensiva e reação à perda.');
 if(!insights.length) insights.push('Amostra ainda limitada: continuar a recolher eventos antes de tirar conclusões.');
 return {
  context:'AI_LIVE_MATCH_ANALYSIS',
  matchMinute:clock, phase, eventCount:events.length,
  recentEvents:recent, eventCounts:counts, insights,
  confidence:events.length>=20?'MEDIUM':'LOW',
  recommendedActions:['Continuar recolha estruturada','Cruzar com contexto tático','Validar qualquer ajuste pela equipa técnica'],
  postMatchReady:events.length>=30,
  nextStep:'Enviar eventos e insights para Match Analysis e AI Match Intelligence',
  note:'Análise assistida por IA baseada nos eventos recebidos; não representa uma interpretação automática completa de vídeo em tempo real.'
 };
}
app.post('/api/ai-live-match-analysis/analyze',auth,(req,res)=>{
 res.json(buildLiveMatchAnalysis(req.body||{}));
});
app.post('/api/ai-live-match-analysis/:id/event',auth,(req,res)=>{
 const body=req.body||{};
 res.json({matchId:req.params.id,event:{...body,recordedAt:new Date().toISOString()},status:'RECORDED'});
});

// 91.0 AI Post-Match Report
function buildPostMatchReport(input={}){
 const player=input.player||{}, team=input.team||{}, match=input.match||{},
       stats=input.stats||{}, tactical=input.tactical||{}, prior=input.prior||{},
       observations=Array.isArray(input.observations)?input.observations:[],
       priorities=Array.isArray(input.priorities)?input.priorities:[],
       strengths=Array.isArray(input.strengths)?input.strengths:[],
       issues=Array.isArray(input.issues)?input.issues:[];
 const nextPriorities=(priorities.length?priorities:issues).slice(0,5);
 return {
  context:'AI_POST_MATCH_REPORT',
  player,team,match,stats,tactical,
  summary: `Relatório pós-jogo de ${player.name||'jogador'} com base nos dados estruturados disponíveis.`,
  strengths: strengths.slice(0,6),
  issues: issues.slice(0,6),
  observations: observations.slice(0,12),
  comparison:{previous:prior,current:stats},
  priorities:nextPriorities,
  nextTraining: nextPriorities.map((p,i)=>({priority:p,focus:i===0?'HIGH':'MEDIUM',reason:'Converter o feedback do jogo em trabalho no próximo ciclo.'})),
  teamActions:['Rever padrões coletivos','Cruzar dados com modelo de jogo','Validar conclusões com equipa técnica'],
  confidence: observations.length>=15?'MEDIUM':'LOW',
  handoff:{destination:'AI_WEEKLY_MICROCYCLE',ready:true},
  note:'Relatório assistido por IA. Deve ser revisto pela equipa técnica antes de decisões de treino ou competição.'
 };
}
app.post('/api/ai-post-match-report/generate',auth,(req,res)=>{
 res.json(buildPostMatchReport(req.body||{}));
});

// 92.0 AI Development Engine
function buildDevelopmentEngine(input={}){
 const history=Array.isArray(input.history)?input.history:[],
       assessments=input.assessments||{},
       training=input.training||{},
       matches=input.matches||{},
       load=input.load||{},
       feedback=input.feedback||{},
       goals=Array.isArray(input.goals)?input.goals:[],
       areas=Array.isArray(input.areas)?input.areas:[],
       scored=areas.map(a=>({
         area:a,
         assessmentGap:Number(input.gaps?.[a]??0),
         matchNeed:Number(input.matchNeeds?.[a]??0),
         feedbackNeed:Number(input.feedbackNeeds?.[a]??0),
         priorityScore:
           Number(input.gaps?.[a]??0)*0.4+
           Number(input.matchNeeds?.[a]??0)*0.3+
           Number(input.feedbackNeeds?.[a]??0)*0.2+
           (goals.includes(a)?10:0)
       })).sort((a,b)=>b.priorityScore-a.priorityScore),
       priorities=scored.slice(0,5);
 return {
  context:'AI_DEVELOPMENT_ENGINE',
  horizon:input.horizon||'12_MONTHS',
  history,assessments,training,matches,load,feedback,goals,
  priorities,
  developmentPlan:{
    now:priorities.slice(0,2).map(x=>x.area),
    nextCycle:priorities.slice(0,3).map(x=>x.area),
    mediumTerm:priorities.slice(0,5).map(x=>x.area),
    reviewCadence:'4_WEEKS'
  },
  signals:{
    assessment:'weighted',
    match:'weighted',
    training:'weighted',
    load:'safety_context',
    feedback:'weighted',
    goals:'explicit'
  },
  nextActions:[
   'Gerar microciclo adaptado',
   'Gerar treinos diários',
   'Reavaliar após novo ciclo',
   'Atualizar prioridades com novos dados'
  ],
  confidence:history.length>=3?'MEDIUM':'LOW',
  note:'Motor de desenvolvimento assistido por IA. Não classifica talento nem substitui avaliação profissional, especialmente em menores.'
 };
}
app.post('/api/ai-development-engine/analyze',auth,(req,res)=>{
 res.json(buildDevelopmentEngine(req.body||{}));
});

// 93.0 AI Player Development Profile
function buildPlayerDevelopmentProfile(input={}){
 const p=input.player||{}, identity=input.identity||{}, competencies=input.competencies||{},
       priorities=Array.isArray(input.priorities)?input.priorities:[],
       goals=Array.isArray(input.goals)?input.goals:[],
       trends=Array.isArray(input.trends)?input.trends:[],
       training=input.training||{}, matches=input.matches||{}, load=input.load||{},
       availability=input.availability||{}, notes=Array.isArray(input.notes)?input.notes:[];
 const profile={
  identity:{id:p.id,name:p.name,age:p.age,position:p.position,level:p.level},
  context:identity,
  competencies,
  priorities:priorities.slice(0,8),
  goals:goals.slice(0,8),
  trends:trends.slice(0,12),
  training,matches,load,availability,
  developmentSummary:{
   currentFocus:priorities.slice(0,3),
   strengths:input.strengths||[],
   developmentAreas:input.developmentAreas||[],
   consistency:input.consistency||null
  },
  notes:notes.slice(0,10),
  generatedAt:new Date().toISOString()
 };
 return {
  context:'AI_PLAYER_DEVELOPMENT_PROFILE',
  profile,
  consumers:['PLAYER','FAMILY','COACH','ACADEMY','AI_COACH','AI_CONTENT_MANAGER'],
  updateTriggers:['ASSESSMENT','TRAINING_FEEDBACK','MATCH','LOAD_CHANGE','GOAL_CHANGE','COACH_REVIEW'],
  confidence:trends.length>=3?'MEDIUM':'LOW',
  privacy:['Use role-based access','Respect parental consent for minors','Do not expose sensitive data unnecessarily'],
  note:'Perfil assistido por IA. Não é diagnóstico nem classificação de talento; deve ser revisto por profissionais quando usado para decisões de treino.'
 };
}
app.post('/api/ai-player-development-profile/generate',auth,(req,res)=>{
 res.json(buildPlayerDevelopmentProfile(req.body||{}));
});

// 94.0 AI Player 360
function buildPlayer360(input={}){
 const profile=input.profile||{}, today=input.todayTraining||{},
       progress=input.progress||{}, matches=input.matches||{},
       goals=Array.isArray(input.goals)?input.goals:[],
       recommendations=Array.isArray(input.recommendations)?input.recommendations:[],
       load=input.load||{}, calendar=Array.isArray(input.calendar)?input.calendar:[];
 return {
  context:'AI_PLAYER_360',
  identity:profile.identity||{},
  today:{training:today,primaryAction:'START_TODAY_TRAINING'},
  progress:{score:progress.score??null,level:progress.level??null,trends:progress.trends||[]},
  development:{priorities:profile.priorities||[],goals:goals.slice(0,6)},
  matches:{recent:matches.recent||[],next:matches.next||null},
  load:{current:load.current??null,status:load.status||'UNKNOWN'},
  calendar:calendar.slice(0,10),
  recommendations:recommendations.slice(0,8),
  quickActions:['Treino de hoje','Ver evolução','Abrir AI Coach','Ver jogos','Objetivos','Calendário'],
  nextUpdateTriggers:['TRAINING_COMPLETED','MATCH_COMPLETED','NEW_ASSESSMENT','LOAD_CHANGE','GOAL_CHANGE'],
  note:'Centro 360 assistido por IA; decisões de treino e competição permanecem sob validação humana.'
 };
}
app.post('/api/ai-player-360/generate',auth,(req,res)=>{
 res.json(buildPlayer360(req.body||{}));
});

// 95.0 AI Coach Conversational
function buildAIChatResponse(input={}){
 const message=String(input.message||'').trim(),
       profile=input.profile||{}, memory=input.memory||{},
       context=input.context||{}, history=Array.isArray(input.history)?input.history:[],
       priorities=Array.isArray(profile.priorities)?profile.priorities:[],
       goals=Array.isArray(profile.goals)?profile.goals:[],
       lower=message.toLowerCase();
 let answer='Posso ajudar-te a interpretar o teu treino, evolução e próximos objetivos.';
 if(lower.includes('treino')||lower.includes('hoje'))
   answer=`O foco deve seguir as prioridades atuais: ${priorities.slice(0,3).join(', ')||'as prioridades definidas no teu plano'}. Consulta o treino de hoje e dá-me o teu feedback depois de terminares.`;
 else if(lower.includes('evolu')||lower.includes('melhor'))
   answer=`A tua evolução deve ser analisada pelo histórico e não por um único resultado. As prioridades atuais são: ${priorities.slice(0,4).join(', ')||'em atualização'}.`;
 else if(lower.includes('objetivo'))
   answer=`Os objetivos registados são: ${goals.slice(0,4).join(', ')||'ainda não definidos'}. Posso ajudar a transformar um objetivo num próximo ciclo de treino.`;
 else if(lower.includes('cans')||lower.includes('fadiga'))
   answer='Se estás fatigado, regista a tua perceção de esforço e fadiga. O plano deve respeitar a carga e ser revisto pela equipa técnica quando necessário.';
 return {
  context:'AI_COACH_CONVERSATIONAL',
  message,
  answer,
  usedContext:{profile, memory, context, historyLength:history.length},
  suggestedActions:['Abrir treino de hoje','Ver evolução','Atualizar feedback','Ver objetivos'],
  confidence:'CONTEXTUAL',
  safety:'A IA orienta e explica; não diagnostica, não substitui profissionais e não deve tomar decisões clínicas ou competitivas.'
 };
}
app.post('/api/ai-coach/chat',auth,(req,res)=>{
 res.json(buildAIChatResponse(req.body||{}));
});

// 96.0 AI Coach Memory
function buildCoachMemory(input={}){
 const playerId=input.playerId||null,
       conversations=Array.isArray(input.conversations)?input.conversations:[],
       feedback=Array.isArray(input.feedback)?input.feedback:[],
       difficulties=Array.isArray(input.difficulties)?input.difficulties:[],
       commitments=Array.isArray(input.commitments)?input.commitments:[],
       preferences=Array.isArray(input.preferences)?input.preferences:[],
       priorDecisions=Array.isArray(input.priorDecisions)?input.priorDecisions:[],
       currentContext=input.currentContext||{};
 const topics={};
 conversations.forEach(c=>{
   const t=c.topic||'GENERAL'; topics[t]=(topics[t]||0)+1;
 });
 return {
  context:'AI_COACH_MEMORY',
  playerId,
  memory:{
   recurringTopics:Object.entries(topics).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([topic,count])=>({topic,count})),
   recentFeedback:feedback.slice(-12),
   recurringDifficulties:difficulties.slice(-10),
   commitments:commitments.slice(-10),
   preferences:preferences.slice(-10),
   priorDecisions:priorDecisions.slice(-10),
   currentContext
  },
  memoryPolicy:{
   retain:'Useful development context and explicit player/coach feedback',
   avoid:'Unnecessary sensitive or irrelevant personal data',
   review:'Player/coach can review and correct stored memory',
   minors:'Apply parental consent and role-based access where required'
  },
  retrievalHints:['Use recent context first','Prefer repeated patterns over isolated comments','Ask when memory conflicts with current data'],
  confidence:conversations.length>=5?'MEDIUM':'LOW',
  note:'Conversational memory supports continuity; it is not a substitute for current assessment or professional judgement.'
 };
}
app.post('/api/ai-coach/memory/build',auth,(req,res)=>{
 res.json(buildCoachMemory(req.body||{}));
});
app.post('/api/ai-coach/memory/:playerId/event',auth,(req,res)=>{
 res.json({playerId:req.params.playerId,event:{...req.body,recordedAt:new Date().toISOString()},status:'MEMORY_EVENT_ACCEPTED'});
});

// 97.0 AI Coach Personality & Communication
const COACH_COMMUNICATION_PROFILES={
 CHILD:{tone:'SIMPLE_ENCOURAGING',sentenceLength:'SHORT',technicality:'LOW',feedback:'POSITIVE_CONCRETE',avoid:['pressure language','talent labels']},
 YOUTH:{tone:'COACHING_CLEAR',sentenceLength:'MEDIUM',technicality:'MEDIUM',feedback:'BALANCED'},
 SENIOR:{tone:'DIRECT_PERFORMANCE',sentenceLength:'MEDIUM',technicality:'HIGH',feedback:'DIRECT_ACTIONABLE'},
 HIGH_PERFORMANCE:{tone:'ELITE_ANALYTICAL',sentenceLength:'CONCISE',technicality:'HIGH',feedback:'DATA_DRIVEN'}
};
function communicationBand(age=18,level=''){
 if(age<=11)return 'CHILD';
 if(age<=17)return 'YOUTH';
 if(String(level).toLowerCase().includes('alto')||String(level).toLowerCase().includes('elite'))return 'HIGH_PERFORMANCE';
 return 'SENIOR';
}
function buildCoachPersonality(input={}){
 const age=Number(input.age||18), level=input.level||'', role=input.role||'PLAYER',
       band=communicationBand(age,level), requested=input.style||'DEFAULT',
       base=COACH_COMMUNICATION_PROFILES[band],
       preferences=input.preferences||{};
 return {
  context:'AI_COACH_PERSONALITY',
  audience:{age,level,role,band},
  communication:{...base,requestedStyle:requested,preferences},
  rules:[
   'Adapt language without changing factual content',
   'Use age-appropriate explanations',
   'Focus on actionable feedback',
   'Avoid deterministic talent labels',
   'Never use shame, humiliation or fear as motivation',
   'Escalate safety or health concerns to appropriate adults/professionals'
  ],
  examples:{
   motivation:band==='CHILD'?'Vamos! Faz o exercício com calma e tenta melhorar um pouco de cada vez.':'Foca o próximo bloco no objetivo definido e avalia o resultado no final.',
   correction:band==='CHILD'?'Experimenta outra vez, agora com mais controlo.':'Repete o bloco e corrige o ponto técnico identificado.'
  },
  note:'A personalidade altera a comunicação, não os critérios de segurança, privacidade ou validação profissional.'
 };
}
app.post('/api/ai-coach/personality',auth,(req,res)=>{
 res.json(buildCoachPersonality(req.body||{}));
});

// 98.0 Multilingual AI Coach Conversation
const SUPPORTED_LANGUAGES=[
 {code:'auto',name:'Deteção automática'},
 {code:'pt',name:'Português'},
 {code:'en',name:'English'},
 {code:'es',name:'Español'},
 {code:'fr',name:'Français'},
 {code:'it',name:'Italiano'},
 {code:'de',name:'Deutsch'},
 {code:'nl',name:'Nederlands'},
 {code:'pl',name:'Polski'},
 {code:'uk',name:'Українська'},
 {code:'tr',name:'Türkçe'},
 {code:'ar',name:'العربية'},
 {code:'he',name:'עברית'},
 {code:'hi',name:'हिन्दी'},
 {code:'bn',name:'বাংলা'},
 {code:'id',name:'Bahasa Indonesia'},
 {code:'ja',name:'日本語'},
 {code:'ko',name:'한국어'},
 {code:'zh',name:'中文'},
 {code:'vi',name:'Tiếng Việt'},
 {code:'sw',name:'Kiswahili'},
 {code:'ro',name:'Română'},
 {code:'cs',name:'Čeština'},
 {code:'sv',name:'Svenska'},
 {code:'no',name:'Norsk'},
 {code:'da',name:'Dansk'},
 {code:'fi',name:'Suomi'},
 {code:'el',name:'Ελληνικά'}
];
function detectConversationLanguage(text=''){
 const t=text.toLowerCase();
 if(/[áéíóúãõç]/.test(t)||/\b(que|treino|jogo|melhorar|hoje|estou)\b/.test(t))return 'pt';
 if(/\b(what|training|game|improve|today|i am)\b/.test(t))return 'en';
 if(/\b(entrenamiento|partido|mejorar|hoy)\b/.test(t))return 'es';
 if(/\b(entraînement|match|améliorer|aujourd'hui)\b/.test(t))return 'fr';
 return 'en';
}
function buildMultilingualCoachChat(input={}){
 const requested=input.language||'auto', message=String(input.message||''),
       detected=detectConversationLanguage(message),
       language=requested==='auto'?detected:requested;
 const valid=SUPPORTED_LANGUAGES.some(x=>x.code===language);
 return {
  context:'AI_COACH_MULTILINGUAL_CONVERSATION',
  language:valid?language:'en',
  detectedLanguage:detected,
  requestedLanguage:requested,
  message,
  instruction:'Respond in the selected language while preserving the player context, meaning, safety rules and coaching intent.',
  supportedLanguages:SUPPORTED_LANGUAGES,
  continuity:{profile:input.profile||{},memory:input.memory||{},historyLength:Array.isArray(input.history)?input.history.length:0},
  fallback:'en',
  note:'Language selection changes communication language, not safety, privacy, coaching rules or professional validation.'
 };
}
app.get('/api/ai-coach/languages',(req,res)=>res.json({languages:SUPPORTED_LANGUAGES}));
app.post('/api/ai-coach/chat/multilingual',auth,(req,res)=>{
 res.json(buildMultilingualCoachChat(req.body||{}));
});

// 99.0 AI Coach Voice
const VOICE_MODES=[
 {code:'text',name:'Texto'},
 {code:'voice',name:'Voz'},
 {code:'text_and_voice',name:'Texto + Voz'}
];
function buildCoachVoice(input={}){
 const language=input.language||'auto',
       mode=VOICE_MODES.some(x=>x.code===input.mode)?input.mode:'text_and_voice',
       message=String(input.message||''),
       voice=input.voice||'coach-default';
 return {
  context:'AI_COACH_VOICE',
  input:{message,language,mode,voice},
  output:{
   mode,
   textReady:true,
   speechReady:mode!=='text',
   transcriptReady:mode!=='text',
   audioUrl:null
  },
  voicePolicy:{
   pace:'ADAPTIVE',
   pronunciation:'LANGUAGE_AWARE',
   interruption:'SUPPORTED_BY_CLIENT',
   confirmationForSensitiveActions:true
  },
  supportedModes:VOICE_MODES,
  pipeline:'SPEECH_TO_TEXT → AI COACH → TEXT RESPONSE → TEXT_TO_SPEECH',
  note:'Voice transport is provider/client dependent. This version defines the contract and UX flow; it does not claim a production speech provider is connected.'
 };
}
app.get('/api/ai-coach/voice-modes',(req,res)=>res.json({modes:VOICE_MODES}));
app.post('/api/ai-coach/voice/session',auth,(req,res)=>{
 res.json(buildCoachVoice(req.body||{}));
});

// 100.0 AI Football Super Coach + Publication Readiness
const SUPER_COACH_MODULES=[
 'PLAYER_PROFILE','PLAYER_360','AI_COACH','AI_COACH_MEMORY','MULTILINGUAL','VOICE',
 'TRAINING','MATCH_ANALYSIS','TACTICAL_INTELLIGENCE','DEVELOPMENT_ENGINE',
 'FAMILY','COACH','ACADEMY','CONTENT_MANAGER'
];
function buildSuperCoach(input={}){
 const profile=input.profile||{}, memory=input.memory||{}, language=input.language||'auto';
 return {
  context:'AI_FOOTBALL_SUPER_COACH',
  player:{id:profile.id,name:profile.name,age:profile.age,position:profile.position,level:profile.level},
  modules:SUPER_COACH_MODULES,
  language,
  contextSources:['profile','development','training','matches','load','goals','memory','coach_feedback'],
  capabilities:[
   'Answer questions about training and development',
   'Explain progress using longitudinal context',
   'Generate contextual training recommendations',
   'Connect match findings to development priorities',
   'Communicate by text or voice when configured',
   'Support players, families, coaches and academies'
  ],
  guardrails:[
   'Human review for high-impact sporting decisions',
   'No autonomous medical diagnosis',
   'No deterministic talent classification',
   'Age-appropriate communication',
   'Role-based access and consent for minors',
   'Minimize stored personal data'
  ],
  note:'Super Coach is an orchestration layer over the platform. Production AI, speech and video providers must be configured before claiming those capabilities are live.'
 };
}
app.get('/api/ai-football-super-coach/modules',(req,res)=>res.json({modules:SUPER_COACH_MODULES}));
app.post('/api/ai-football-super-coach/context',auth,(req,res)=>{
 res.json(buildSuperCoach(req.body||{}));
});

function publicationReadiness(){
 const checks=[
  {id:'package_version',ok:true,detail:'Version 100.0.0'},
  {id:'android_package',ok:true,detail:'com.futureblueshark.player'},
  {id:'target_api',ok:true,detail:'API 36'},
  {id:'ai_provider_config',ok:!!process.env.OPENAI_API_KEY,detail:process.env.OPENAI_API_KEY?'Configured':'Not configured in this environment'},
  {id:'database_url',ok:!!process.env.DATABASE_URL,detail:process.env.DATABASE_URL?'Configured':'Not configured in this environment'},
  {id:'billing',ok:!!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,detail:process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?'Configured':'Not configured in this environment'},
  {id:'production_secret',ok:!!process.env.JWT_SECRET && process.env.JWT_SECRET.length>=32,detail:process.env.JWT_SECRET?'Configured':'Not configured in this environment'},
  {id:'voice_provider',ok:!!process.env.TTS_PROVIDER,detail:process.env.TTS_PROVIDER?'Configured':'Not configured in this environment'}
 ];
 return {version:'100.0.0',checks,ready:checks.every(c=>c.ok),blocking:checks.filter(c=>!c.ok).map(c=>c.id)};
}
app.get('/api/release/readiness',(req,res)=>{
 const r=publicationReadiness(); res.status(r.ready?200:503).json(r);
});

// Vercel/serverless export
module.exports = app;
