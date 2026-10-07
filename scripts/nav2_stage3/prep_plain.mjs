// A fresh 4-fund report for the holder fixture user (A, B, C from the holder statement plus D from the second statement), made with the CURRENT code.
import { logoutAll, USERS } from './_lib.mjs';
import { generate, uploadAndAccept } from './_flow.mjs';
console.log('holder', (await uploadAndAccept(USERS.holder, 'nav2s3-holder')).ok);
console.log('second statement (A and D)', (await uploadAndAccept(USERS.holder, 'nav2s3-other')).ok);
const g = await generate(USERS.holder);
console.log('report', g.status, g.id);
await logoutAll();
