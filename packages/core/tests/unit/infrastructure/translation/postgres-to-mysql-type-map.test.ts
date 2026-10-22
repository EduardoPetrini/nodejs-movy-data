import { describe, it, expect } from 'vitest';
import { POSTGRES_TO_MYSQL_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/postgres-to-mysql.type-map';

describe('POSTGRES_TO_MYSQL_TYPE_MAP', () => {
  describe('boolean', () => {
    it.each(['boolean', 'bool'])('maps %s to tinyint(1)', (type) => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP[type]).toBe('tinyint(1)');
    });
  });

  describe('integer types', () => {
    it.each([['smallint', 'smallint'], ['int2', 'smallint'], ['smallserial', 'smallint']])(
      'maps %s to %s',
      (src, dst) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[src]).toBe(dst); }
    );

    it.each([['integer', 'int'], ['int', 'int'], ['int4', 'int'], ['serial', 'int']])(
      'maps %s to %s',
      (src, dst) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[src]).toBe(dst); }
    );

    it.each([['bigint', 'bigint'], ['int8', 'bigint'], ['bigserial', 'bigint']])(
      'maps %s to %s',
      (src, dst) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[src]).toBe(dst); }
    );
  });

  describe('floating point', () => {
    it.each([['real', 'float'], ['float4', 'float']])('maps %s to %s', (src, dst) => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP[src]).toBe(dst);
    });

    it.each([['double precision', 'double'], ['float8', 'double'], ['float', 'double']])(
      'maps %s to %s',
      (src, dst) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[src]).toBe(dst); }
    );
  });

  describe('fixed-point', () => {
    it.each(['numeric', 'decimal'])('maps %s to decimal', (type) => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP[type]).toBe('decimal');
    });
  });

  describe('character types', () => {
    it('maps varchar to varchar', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['varchar']).toBe('varchar');
    });

    it('maps character varying to varchar', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['character varying']).toBe('varchar');
    });

    it('maps text to longtext', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['text']).toBe('longtext');
    });

    it('maps bytea to longblob', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['bytea']).toBe('longblob');
    });
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['date']).toBe('date');
    });

    it.each(['time', 'time without time zone', 'time with time zone'])(
      'maps %s to time',
      (type) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[type]).toBe('time'); }
    );

    it.each(['timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'])(
      'maps %s to datetime',
      (type) => { expect(POSTGRES_TO_MYSQL_TYPE_MAP[type]).toBe('datetime'); }
    );
  });

  describe('special types', () => {
    it('maps uuid to char(36)', () => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP['uuid']).toBe('char(36)');
    });

    it.each(['json', 'jsonb'])('maps %s to json', (type) => {
      expect(POSTGRES_TO_MYSQL_TYPE_MAP[type]).toBe('json');
    });
  });
});
