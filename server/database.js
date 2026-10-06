'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

// All transactional statements use the same connection. The singleton row locks
// reservation/reset decisions across processes as well as concurrent requests.
class Database {
  constructor() {
    this.pool = require('mysql2/promise').createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'parking',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'smart_parking',
      charset: 'utf8mb4', connectionLimit: 5, supportBigNumbers: true,
    });
    this.context = new AsyncLocalStorage();
  }
  async init() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await this.pool.query(sql);
  }
  prepare(sql) {
    const execute = async args => {
      const connection = this.context.getStore() || this.pool;
      const [result] = await connection.execute(sql, args);
      return result;
    };
    return {
      all: (...args) => execute(args),
      get: async (...args) => (await execute(args))[0],
      run: async (...args) => ({ changes: (await execute(args)).affectedRows }),
    };
  }
  async transaction(fn) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM parking_lock WHERE id = 1 FOR UPDATE');
      const result = await this.context.run(connection, fn);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  close() { return this.pool.end(); }
}
module.exports = Database;
