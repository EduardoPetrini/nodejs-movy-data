import { describe, it, expect } from 'vitest';
import { MSSQL_TO_MYSQL_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/mssql-to-mysql.type-map';

describe('MSSQL_TO_MYSQL_TYPE_MAP', () => {
  describe('exact matches (resolved before normalisation)', () => {
    it('maps nvarchar(max) to longtext', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['nvarchar(max)']).toBe('longtext');
    });

    it('maps varchar(max) to longtext', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['varchar(max)']).toBe('longtext');
    });

    it('maps varbinary(max) to longblob', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['varbinary(max)']).toBe('longblob');
    });

    it('maps ntext to longtext', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['ntext']).toBe('longtext');
    });

    it('maps image to longblob', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['image']).toBe('longblob');
    });
  });

  describe('integer types', () => {
    it('maps bit to tinyint(1)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['bit']).toBe('tinyint(1)');
    });

    it('maps tinyint to tinyint', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['tinyint']).toBe('tinyint');
    });

    it('maps smallint to smallint', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['smallint']).toBe('smallint');
    });

    it('maps int to int', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['int']).toBe('int');
    });

    it('maps integer to int', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['integer']).toBe('int');
    });

    it('maps bigint to bigint', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['bigint']).toBe('bigint');
    });
  });

  describe('floating point types', () => {
    it('maps float to double', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['float']).toBe('double');
    });

    it('maps real to float', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['real']).toBe('float');
    });
  });

  describe('fixed-point types', () => {
    it('maps decimal to decimal', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['decimal']).toBe('decimal');
    });

    it('maps numeric to decimal', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['numeric']).toBe('decimal');
    });

    it('maps money to decimal(19,4)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['money']).toBe('decimal(19,4)');
    });

    it('maps smallmoney to decimal(10,4)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['smallmoney']).toBe('decimal(10,4)');
    });
  });

  describe('character types', () => {
    it('maps char to char', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['char']).toBe('char');
    });

    it('maps nchar to char', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['nchar']).toBe('char');
    });

    it('maps varchar to varchar', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['varchar']).toBe('varchar');
    });

    it('maps nvarchar to varchar', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['nvarchar']).toBe('varchar');
    });

    it('maps text to longtext', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['text']).toBe('longtext');
    });
  });

  describe('binary types', () => {
    it('maps binary to binary', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['binary']).toBe('binary');
    });

    it('maps varbinary to varbinary', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['varbinary']).toBe('varbinary');
    });

    it('maps timestamp (rowversion) to binary(8)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['timestamp']).toBe('binary(8)');
    });

    it('maps rowversion to binary(8)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['rowversion']).toBe('binary(8)');
    });
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['date']).toBe('date');
    });

    it('maps time to time', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['time']).toBe('time');
    });

    it('maps datetime to datetime', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['datetime']).toBe('datetime');
    });

    it('maps datetime2 to datetime', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['datetime2']).toBe('datetime');
    });

    it('maps smalldatetime to datetime', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['smalldatetime']).toBe('datetime');
    });

    it('maps datetimeoffset to datetime', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['datetimeoffset']).toBe('datetime');
    });
  });

  describe('unique / structured types', () => {
    it('maps uniqueidentifier to char(36)', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['uniqueidentifier']).toBe('char(36)');
    });

    it('maps xml to longtext', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['xml']).toBe('longtext');
    });

    it('maps sql_variant to text', () => {
      expect(MSSQL_TO_MYSQL_TYPE_MAP['sql_variant']).toBe('text');
    });
  });
});
