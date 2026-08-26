import { describe, it, expect } from 'vitest';
import { POSTGRES_TO_MSSQL_TYPE_MAP } from '../../../../src/infrastructure/database/translation/type-maps/postgres-to-mssql.type-map';

describe('POSTGRES_TO_MSSQL_TYPE_MAP', () => {
  describe('boolean', () => {
    it('maps boolean to bit', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['boolean']).toBe('bit');
    });

    it('maps bool to bit', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['bool']).toBe('bit');
    });
  });

  describe('integer types', () => {
    it('maps smallint to smallint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['smallint']).toBe('smallint');
    });

    it('maps int2 to smallint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['int2']).toBe('smallint');
    });

    it('maps integer to int', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['integer']).toBe('int');
    });

    it('maps int to int', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['int']).toBe('int');
    });

    it('maps int4 to int', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['int4']).toBe('int');
    });

    it('maps bigint to bigint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['bigint']).toBe('bigint');
    });

    it('maps int8 to bigint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['int8']).toBe('bigint');
    });

    it('maps serial to int', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['serial']).toBe('int');
    });

    it('maps smallserial to smallint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['smallserial']).toBe('smallint');
    });

    it('maps bigserial to bigint', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['bigserial']).toBe('bigint');
    });
  });

  describe('floating point types', () => {
    it('maps real to real', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['real']).toBe('real');
    });

    it('maps float4 to real', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['float4']).toBe('real');
    });

    it('maps double precision to float', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['double precision']).toBe('float');
    });

    it('maps float8 to float', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['float8']).toBe('float');
    });
  });

  describe('fixed-point types', () => {
    it('maps numeric to numeric', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['numeric']).toBe('numeric');
    });

    it('maps decimal to decimal', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['decimal']).toBe('decimal');
    });

    it('maps money to decimal(19,4)', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['money']).toBe('decimal(19,4)');
    });
  });

  describe('character types', () => {
    it('maps char to nchar', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['char']).toBe('nchar');
    });

    it('maps character to nchar', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['character']).toBe('nchar');
    });

    it('maps varchar to nvarchar', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['varchar']).toBe('nvarchar');
    });

    it('maps character varying to nvarchar', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['character varying']).toBe('nvarchar');
    });

    it('maps text to nvarchar(max)', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['text']).toBe('nvarchar(max)');
    });
  });

  describe('binary types', () => {
    it('maps bytea to varbinary(max)', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['bytea']).toBe('varbinary(max)');
    });
  });

  describe('date / time types', () => {
    it('maps date to date', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['date']).toBe('date');
    });

    it('maps time to time', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['time']).toBe('time');
    });

    it('maps time without time zone to time', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['time without time zone']).toBe('time');
    });

    it('maps timestamp to datetime2', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['timestamp']).toBe('datetime2');
    });

    it('maps timestamp without time zone to datetime2', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['timestamp without time zone']).toBe('datetime2');
    });

    it('maps timestamp with time zone to datetimeoffset', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['timestamp with time zone']).toBe('datetimeoffset');
    });

    it('maps timestamptz to datetimeoffset', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['timestamptz']).toBe('datetimeoffset');
    });
  });

  describe('unique / structured types', () => {
    it('maps uuid to uniqueidentifier', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['uuid']).toBe('uniqueidentifier');
    });

    it('maps jsonb to nvarchar(max)', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['jsonb']).toBe('nvarchar(max)');
    });

    it('maps json to nvarchar(max)', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['json']).toBe('nvarchar(max)');
    });

    it('maps xml to xml', () => {
      expect(POSTGRES_TO_MSSQL_TYPE_MAP['xml']).toBe('xml');
    });
  });
});
