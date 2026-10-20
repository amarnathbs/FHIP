// Prepares what journey 5 needs: the holder and the other user each with a stored report (statements through the real routes).
import { logoutAll, USERS } from './_lib.mjs';
import { generate, uploadAndAccept } from './_flow.mjs';
const a = await uploadAndAccept(USERS.holder, 'nav2s3-holder'); console.log('holder', a.ok);
const g = await generate(USERS.holder); console.log('holder report', g.status);
const b = await uploadAndAccept(USERS.other, 'nav2s3-other'); const c = await uploadAndAccept(USERS.other, 'nav2s3-other-e'); console.log('other', b.ok, c.ok);
const h = await generate(USERS.other); console.log('other report', h.status);
await logoutAll();
