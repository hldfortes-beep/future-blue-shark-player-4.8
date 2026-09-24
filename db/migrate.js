require('dotenv').config();
const fs=require('fs'), path=require('path'), {Client}=require('pg');
(async()=>{
 if(!process.env.DATABASE_URL){ console.log('DATABASE_URL not configured; migrations skipped.'); return; }
 const c=new Client({connectionString:process.env.DATABASE_URL});
 await c.connect();
 await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 const dir=path.join(__dirname,'migrations');
 for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort()){
   const version=f.replace('.sql','');
   const r=await c.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version]);
   if(!r.rowCount){ await c.query(fs.readFileSync(path.join(dir,f),'utf8')); await c.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]); console.log('Applied',version); }
 }
 await c.end();
})().catch(e=>{console.error(e);process.exit(1)});
