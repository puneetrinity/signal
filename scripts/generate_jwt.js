/* eslint-disable @typescript-eslint/no-require-imports */
const { SignJWT, importPKCS8 } = require('jose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

(async () => {
  const pk = await importPKCS8(process.env.SIGNAL_JWT_PRIVATE_KEY, 'RS256');
  const jwt = await new SignJWT({
    tenant_id: 'postman-test',
    sub: 'postman',
    scopes: 'jobs:source jobs:results enrich:batch pdl:contact',
    jti: uuidv4(),
    actor_type: 'service'
  })
    .setProtectedHeader({ alg: 'RS256', kid: process.env.SIGNAL_JWT_ACTIVE_KID || 'v1' })
    .setIssuedAt()
    .setIssuer('vantahire')
    .setAudience('signal')
    .setExpirationTime('1h')
    .sign(pk);
  
  console.log(jwt);
})();
