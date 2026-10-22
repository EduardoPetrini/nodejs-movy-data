import { describe, it, expect } from 'vitest';
import { MYSQL_TO_MSSQL_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/mysql-to-mssql.type-map';

describe('MYSQL_TO_MSSQL_TYPE_MAP', () => {
  describe('exact matches (resolved before normalisation)', () => {
    it('maps tinyint(1) to bit', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['tinyint(1)']).toBe('bit');
    });
  });

  describe('integer types', () => {
    it('maps tinyint to tinyint', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['tinyint']).toBe('tinyint');
    });

    it('maps smallint to smallint', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['smallint']).toBe('smallint');
    });

    it('maps mediumint to int', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['mediumint']).toBe('int');
    });

    it('maps int to int', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['int']).toBe('int');
    });

    it('maps integer to int', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['integer']).toBe('int');
    });

    it('maps bigint to bigint', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['bigint']).toBe('bigint');
    });

    it('maps year to smallint', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['year']).toBe('smallint');
    });
  });

  describe('floating point types', () => {
    it('maps float to real', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['float']).toBe('real');
    });

    it('maps double to float', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['double']).toBe('float');
    });

    it('maps double precision to float', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['double precision']).toBe('float');
    });
  });

  describe('fixed-point types', () => {
    it('maps decimal to decimal', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['decimal']).toBe('decimal');
    });

    it('maps numeric to numeric', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['numeric']).toBe('numeric');
    });
  });

  describe('character types', () => {
    it('maps char to nchar', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['char']).toBe('nchar');
    });

    it('maps varchar to nvarchar', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['varchar']).toBe('nvarchar');
    });

    it('maps character varying to nvarchar', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['character varying']).toBe('nvarchar');
    });

    it.each(['tinytext', 'text', 'mediumtext', 'longtext'])(
      'maps %s to nvarchar(max)',
      (type) => {
        expect(MYSQL_TO_MSSQL_TYPE_MAP[type]).toBe('nvarchar(max)');
      }
    );
  });

  describe('binary / blob types', () => {
    it('maps binary to binary', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['binary']).toBe('binary');
    });

    it('maps varbinary to varbinary', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['varbinary']).toBe('varbinary');
    });

    it.each(['tinyblob', 'blob', 'mediumblob', 'longblob'])(
      'maps %s to varbinary(max)',
      (type) => {
        expect(MYSQL_TO_MSSQL_TYPE_MAP[type]).toBe('varbinary(max)');
      }
    );
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['date']).toBe('date');
    });

    it('maps time to time', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['time']).toBe('time');
    });

    it('maps datetime to datetime2', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['datetime']).toBe('datetime2');
    });

    it('maps timestamp to datetimeoffset', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['timestamp']).toBe('datetimeoffset');
    });
  });

  describe('json / enum / set', () => {
    it('maps json to nvarchar(max)', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['json']).toBe('nvarchar(max)');
    });

    it('maps enum to nvarchar(255)', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['enum']).toBe('nvarchar(255)');
    });

    it('maps set to nvarchar(255)', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['set']).toBe('nvarchar(255)');
    });
  });

  describe('bit type', () => {
    it('maps bit to bit', () => {
      expect(MYSQL_TO_MSSQL_TYPE_MAP['bit']).toBe('bit');
    });
  });
});
