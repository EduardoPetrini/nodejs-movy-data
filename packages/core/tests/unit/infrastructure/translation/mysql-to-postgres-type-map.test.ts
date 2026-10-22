import { describe, it, expect } from 'vitest';
import { MYSQL_TO_POSTGRES_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/mysql-to-postgres.type-map';

describe('MYSQL_TO_POSTGRES_TYPE_MAP', () => {
  describe('integer types', () => {
    it('maps tinyint(1) to boolean', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['tinyint(1)']).toBe('boolean');
    });

    it('maps tinyint to smallint', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['tinyint']).toBe('smallint');
    });

    it('maps smallint to smallint', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['smallint']).toBe('smallint');
    });

    it('maps mediumint to integer', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['mediumint']).toBe('integer');
    });

    it('maps int to integer', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['int']).toBe('integer');
    });

    it('maps integer to integer', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['integer']).toBe('integer');
    });

    it('maps bigint to bigint', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['bigint']).toBe('bigint');
    });
  });

  describe('floating point types', () => {
    it('maps float to real', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['float']).toBe('real');
    });

    it('maps double to double precision', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['double']).toBe('double precision');
    });

    it('maps double precision to double precision', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['double precision']).toBe('double precision');
    });
  });

  describe('fixed-point types', () => {
    it('maps decimal to numeric', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['decimal']).toBe('numeric');
    });

    it('maps numeric to numeric', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['numeric']).toBe('numeric');
    });
  });

  describe('character types', () => {
    it('maps char to char', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['char']).toBe('char');
    });

    it('maps varchar to varchar', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['varchar']).toBe('varchar');
    });
  });

  describe('binary / blob types', () => {
    it.each(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'])(
      'maps %s to bytea',
      (type) => {
        expect(MYSQL_TO_POSTGRES_TYPE_MAP[type]).toBe('bytea');
      }
    );
  });

  describe('text types', () => {
    it.each(['tinytext', 'text', 'mediumtext', 'longtext'])(
      'maps %s to text',
      (type) => {
        expect(MYSQL_TO_POSTGRES_TYPE_MAP[type]).toBe('text');
      }
    );
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['date']).toBe('date');
    });

    it('maps time to time', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['time']).toBe('time');
    });

    it('maps datetime to timestamp without time zone', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['datetime']).toBe('timestamp without time zone');
    });

    it('maps timestamp to timestamp with time zone', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['timestamp']).toBe('timestamp with time zone');
    });

    it('maps year to integer', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['year']).toBe('integer');
    });
  });

  describe('json / enum / set', () => {
    it('maps json to jsonb', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['json']).toBe('jsonb');
    });

    it('maps enum to text', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['enum']).toBe('text');
    });

    it('maps set to text', () => {
      expect(MYSQL_TO_POSTGRES_TYPE_MAP['set']).toBe('text');
    });
  });
});
