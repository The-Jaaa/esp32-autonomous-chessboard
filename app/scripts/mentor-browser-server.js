const fs = require('fs');
const path = require('path');

const databasePath = path.join(__dirname, '..', 'tmp', 'mentor-playwright.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

process.env.MENTOR_DB_PATH = databasePath;
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
process.env.PORT = '3010';

const { server } = require('../server');
server.listen(Number(process.env.PORT), () => {
  console.log(`Mentor browser test server listening on port ${process.env.PORT}`);
});
