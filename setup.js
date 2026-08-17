/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const envContent = `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/peoplehub
REDIS_URL=redis://localhost:6379
SIGNAL_JWT_PRIVATE_KEY="${privateKey.trim().replace(/\n/g, '\\n')}"
VANTAHIRE_JWT_PUBLIC_KEY="${publicKey.trim().replace(/\n/g, '\\n')}"
SIGNAL_JWT_ACTIVE_KID=v1
`;

fs.writeFileSync('.env', envContent);
console.log('.env generated successfully');
