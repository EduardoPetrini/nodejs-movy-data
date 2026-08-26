import { describe, it, expect } from 'vitest';
import { MSSQL_TO_POSTGRES_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/mssql-to-postgres.type-map';

describe('MSSQL_TO_POSTGRES_TYPE_MAP', () => {
  describe('exact matches (resolved before normalisation)', () => {
    it('maps nvarchar(max) to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['nvarchar(max)']).toBe('text');
    });

    it('maps varchar(max) to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['varchar(max)']).toBe('text');
    });

    it('maps varbinary(max) to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['varbinary(max)']).toBe('bytea');
    });

    it('maps ntext to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['ntext']).toBe('text');
    });

    it('maps image to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['image']).toBe('bytea');
    });
  });

  describe('integer types', () => {
    it('maps bit to boolean', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['bit']).toBe('boolean');
    });

    it('maps tinyint to smallint', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['tinyint']).toBe('smallint');
    });

    it('maps smallint to smallint', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['smallint']).toBe('smallint');
    });

    it('maps int to integer', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['int']).toBe('integer');
    });

    it('maps integer to integer', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['integer']).toBe('integer');
    });

    it('maps bigint to bigint', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['bigint']).toBe('bigint');
    });
  });

  describe('floating point types', () => {
    it('maps float to double precision', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['float']).toBe('double precision');
    });

    it('maps real to real', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['real']).toBe('real');
    });
  });

  describe('fixed-point types', () => {
    it('maps decimal to numeric', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['decimal']).toBe('numeric');
    });

    it('maps numeric to numeric', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['numeric']).toBe('numeric');
    });

    it('maps money to numeric(19,4)', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['money']).toBe('numeric(19,4)');
    });

    it('maps smallmoney to numeric(10,4)', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['smallmoney']).toBe('numeric(10,4)');
    });
  });

  describe('character types', () => {
    it('maps char to char', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['char']).toBe('char');
    });

    it('maps nchar to char', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['nchar']).toBe('char');
    });

    it('maps varchar to varchar', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['varchar']).toBe('varchar');
    });

    it('maps nvarchar to varchar', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['nvarchar']).toBe('varchar');
    });

    it('maps text to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['text']).toBe('text');
    });
  });

  describe('binary types', () => {
    it('maps binary to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['binary']).toBe('bytea');
    });

    it('maps varbinary to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['varbinary']).toBe('bytea');
    });

    it('maps timestamp (rowversion) to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['timestamp']).toBe('bytea');
    });

    it('maps rowversion to bytea', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['rowversion']).toBe('bytea');
    });
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['date']).toBe('date');
    });

    it('maps time to time', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['time']).toBe('time');
    });

    it('maps datetime to timestamp without time zone', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['datetime']).toBe('timestamp without time zone');
    });

    it('maps datetime2 to timestamp without time zone', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['datetime2']).toBe('timestamp without time zone');
    });

    it('maps smalldatetime to timestamp without time zone', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['smalldatetime']).toBe('timestamp without time zone');
    });

    it('maps datetimeoffset to timestamp with time zone', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['datetimeoffset']).toBe('timestamp with time zone');
    });
  });

  describe('unique / structured types', () => {
    it('maps uniqueidentifier to uuid', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['uniqueidentifier']).toBe('uuid');
    });

    it('maps xml to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['xml']).toBe('text');
    });

    it('maps sql_variant to text', () => {
      expect(MSSQL_TO_POSTGRES_TYPE_MAP['sql_variant']).toBe('text');
    });
  });
});
