const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');
const url = process.env.DATABASE_URL || '';
const provider = url.startsWith('postgres') ? 'postgresql' : 'sqlite';
const next = schema.replace(
  /provider\s*=\s*"(sqlite|postgresql)"/,
  `provider = "${provider}"`
);

if (next !== schema) {
  fs.writeFileSync(schemaPath, next);
}

console.log(`Prisma provider: ${provider}`);
