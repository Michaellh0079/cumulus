import { AsyncOperationStatus, AsyncOperationType } from '@cumulus/types/api/async_operations';

export interface PostgresAsyncOperation {
  id: string
  description: string
  operation_type: AsyncOperationType
  status: AsyncOperationStatus
  output?: Object
  task_arn?: string
  created_at?: Date
  updated_at?: Date
}

export interface PostgresAsyncOperationRecord extends PostgresAsyncOperation {
  created_at: Date
  updated_at: Date
}

export interface PostgresCollection {
  name: string
  version: string
  granule_id_validation_regex: string
  granule_id_extraction_regex: string
  files: string
  process?: string
  duplicate_handling?: string
  report_to_ems?: boolean
  sample_file_name?: string
  url_path?: string
  ignore_files_config_for_discovery?: boolean
  meta?: string
  tags?: string
  created_at?: Date
  updated_at?: Date
}

export interface PostgresCollectionRecord extends PostgresCollection {
  created_at: Date
  updated_at: Date
}

export interface ExecutionRecord {
  arn: string
  async_operation_cumulus_id?: number
  collection_cumulus_id?: number
  parent_cumulus_id?: number
  cumulus_version: string
  created_at: Date
  updated_at: Date
}

/**
 * PostgresProvider
 *
 * This interface describes a Provider object in postgres compatible format that
 * is ready for write to Cumulus's postgres database instance
 */
export interface PostgresProvider {
  certificate_uri?: string | null
  cm_key_id?: string | null,
  created_at?: number | null,
  cumulus_id?: number | null,
  global_connection_limit?: number | null,
  host: string,
  name: string,
  password?: string,
  port?: number| null,
  private_key?: string | null,
  protocol: string,
  updated_at?: number | null,
  username?: string | null,
}

/**
 * PostgresProviderRecord
 *
 * This interface describes a Provider Record that has been retrieved from
 * postgres for reading.  It differs from the PostgresProvider interface in that it types
 * the autogenerated/required fields in the Postgres database as required
 */
export interface PostgresProviderRecord extends PostgresProvider {
  created_at: number,
  updated_at: number,
  cumulusId: number,
}