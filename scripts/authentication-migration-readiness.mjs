import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {authenticationReadiness} from '../lib/authentication-migration.mjs';
import {readNormalizedState} from '../lib/postgres-store.mjs';
import {blank} from '../server.mjs';

// This inventory never initializes/migrates the database or writes proof state.
export async function migrationInventory({connectionString,ssl=true,pepper,stateFile}={}){
 if(!pepper)throw Error('SECRET_PEPPER is required.');
 if(stateFile)return authenticationReadiness(JSON.parse(await readFile(stateFile,'utf8')),{pepper});
 if(!connectionString)throw Error('DATABASE_URL is required.');
 const pool=new pg.Pool({connectionString,ssl:ssl?{rejectUnauthorized:true}:false,max:1,connectionTimeoutMillis:10000});let client;
 try{client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const state=await readNormalizedState(client,blank);const result=authenticationReadiness(state,{pepper});await client.query('ROLLBACK');return result;}
 finally{client?.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const index=process.argv.indexOf('--state-file');const result=await migrationInventory({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL!=='false',pepper:process.env.SECRET_PEPPER,stateFile:index>=0?process.argv[index+1]:undefined});process.stdout.write(JSON.stringify(result,null,2)+'\n');if(process.argv.includes('--require-ready')&&!result.ready)process.exitCode=2;}
 catch{console.error('Migration inventory failed. Check database read access, snapshot format and secret-pepper configuration. No migration was applied.');process.exitCode=1;}
}
