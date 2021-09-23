'use strict';

const cloneDeep = require('lodash/cloneDeep');
const isArray = require('lodash/isArray');

const awsClients = require('@cumulus/aws-client/services');
const s3Utils = require('@cumulus/aws-client/S3');
const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const { CMR } = require('@cumulus/cmr-client');
const cmrjsCmrUtils = require('@cumulus/cmrjs/cmr-utils');
const {
  indexGranule,
} = require('@cumulus/es-client/indexer');
const {
  Search,
} = require('@cumulus/es-client/search');
const Logger = require('@cumulus/logger');
const { getCollectionIdFromMessage } = require('@cumulus/message/Collections');
const {
  getMessageExecutionArn,
  getExecutionUrlFromArn,
} = require('@cumulus/message/Executions');
const {
  getMessageGranules,
  getGranuleQueryFields,
  generateGranuleApiRecord,
  getGranuleTimeToArchive,
  getGranuleTimeToPreprocess,
  getGranuleProductVolume,
  getGranuleStatus,
} = require('@cumulus/message/Granules');
const {
  getMessagePdrName,
} = require('@cumulus/message/PDRs');
const {
  getMessageProvider,
} = require('@cumulus/message/Providers');
const {
  getMessageWorkflowStartTime,
  getMetaStatus,
  getWorkflowDuration,
} = require('@cumulus/message/workflows');
const { parseException } = require('@cumulus/message/utils');
const { buildURL } = require('@cumulus/common/URLUtils');
const { removeNilProperties } = require('@cumulus/common/util');
const {
  DeletePublishedGranule,
} = require('@cumulus/errors');
const {
  generateMoveFileParams,
} = require('@cumulus/ingest/granule');

const Manager = require('./base');

const { CumulusModelError } = require('./errors');
const FileUtils = require('../lib/FileUtils');
const {
  getExecutionProcessingTimeInfo,
  translateGranule,
} = require('../lib/granules');
const GranuleSearchQueue = require('../lib/GranuleSearchQueue');

const granuleSchema = require('./schemas').granule;

const logger = new Logger({ sender: '@cumulus/api/models/granules' });

class Granule extends Manager {
  constructor({
    fileUtils = FileUtils,
    stepFunctionUtils = StepFunctions,
    cmrUtils = cmrjsCmrUtils,
  } = {}) {
    const globalSecondaryIndexes = [{
      IndexName: 'collectionId-granuleId-index',
      KeySchema: [
        {
          AttributeName: 'collectionId',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'granuleId',
          KeyType: 'RANGE',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 10,
      },
    }];

    super({
      tableName: process.env.GranulesTable,
      tableHash: { name: 'granuleId', type: 'S' },
      tableAttributes: [{ name: 'collectionId', type: 'S' }],
      tableIndexes: { GlobalSecondaryIndexes: globalSecondaryIndexes },
      schema: granuleSchema,
    });

    this.fileUtils = fileUtils;
    this.stepFunctionUtils = stepFunctionUtils;
    this.cmrUtils = cmrUtils;
  }

  async get(...args) {
    return translateGranule(
      await super.get(...args),
      this.fileUtils
    );
  }

  getRecord({ granuleId }) {
    return super.get({ granuleId });
  }

  async batchGet(...args) {
    const result = cloneDeep(await super.batchGet(...args));

    result.Responses[this.tableName] = await Promise.all(
      result.Responses[this.tableName].map((response) => translateGranule(response))
    );

    return result;
  }

  async scan(...args) {
    const scanResponse = await super.scan(...args);

    if (scanResponse.Items) {
      return {
        ...scanResponse,
        Items: await Promise.all(scanResponse.Items.map(
          (response) => translateGranule(response)
        )),
      };
    }

    return scanResponse;
  }

  /**
   * Remove granule record from CMR
   *
   * @param {Object} granule - A granule record
   * @throws {CumulusModelError|Error}
   * @returns {Promise}
   * @private
   */
  async _removeGranuleFromCmr(granule) {
    logger.info(`granules.removeGranuleFromCmrByGranule ${granule.granuleId}`);

    if (!granule.published || !granule.cmrLink) {
      throw new CumulusModelError(`Granule ${granule.granuleId} is not published to CMR, so cannot be removed from CMR`);
    }

    const cmrSettings = await this.cmrUtils.getCmrSettings();
    const cmr = new CMR(cmrSettings);
    const metadata = await cmr.getGranuleMetadata(granule.cmrLink);

    // Use granule UR to delete from CMR
    await cmr.deleteGranule(metadata.title, granule.collectionId);
  }

  /*
  * DEPRECATED: This has moved to /lib/granule-rmove-from-cmr.js
  */
  async removeGranuleFromCmrByGranule(granule) {
    await this._removeGranuleFromCmr(granule);
    return this.update({ granuleId: granule.granuleId }, { published: false }, ['cmrLink']);
  }

  /**
   * With the params for moving a granule, return the files that already exist at
   * the move location
   *
   * @param {Object} granule - the granule object
   * @param {Array<{regex: string, bucket: string, filepath: string}>} destinations
   * - list of destinations specified
   *    regex - regex for matching filepath of file to new destination
   *    bucket - aws bucket of the destination
   *    filepath - file path/directory on the bucket for the destination
   * @returns {Promise<Array<Object>>} - promise that resolves to a list of files
   * that already exist at the destination that they would be written to if they
   * were to be moved via the move granules call
   */
  async getFilesExistingAtLocation(granule, destinations) {
    const moveFileParams = generateMoveFileParams(granule.files, destinations);

    const fileExistsPromises = moveFileParams.map(async (moveFileParam) => {
      const { target, file } = moveFileParam;
      if (target) {
        const exists = await s3Utils.fileExists(target.Bucket, target.Key);

        if (exists) {
          return Promise.resolve(file);
        }
      }

      return Promise.resolve();
    });

    const existingFiles = await Promise.all(fileExistsPromises);

    return existingFiles.filter((file) => file);
  }

  /**
   * Returns the params to pass to GranulesSeachQueue
   * either as an object/array or a joined expression
   * @param {Object} searchParams - optional, search parameters
   * @param {boolean} isQuery - optional, true if the params are for a query
   * @returns {Array<Object>} the granules' queue for a given collection
   */
  getDynamoDbSearchParams(searchParams = {}, isQuery = true) {
    const attributeNames = {};
    const attributeValues = {};
    const filterArray = [];
    const keyConditionArray = [];

    Object.entries(searchParams).forEach(([key, value]) => {
      const field = key.includes('__') ? key.split('__').shift() : key;
      attributeNames[`#${field}`] = field;

      let expression;
      if (key.endsWith('__from') || key.endsWith('__to')) {
        const operation = key.endsWith('__from') ? '>=' : '<=';
        attributeValues[`:${key}`] = value;
        expression = `#${field} ${operation} :${key}`;
      } else if (isArray(value)) {
        const operation = 'IN';
        const keyValues = [];
        value.forEach((val, index) => {
          attributeValues[`:${key}${index}`] = val;
          keyValues.push(`:${key}${index}`);
        });
        expression = `#${field} ${operation} (${keyValues.join(', ')})`;
      } else {
        const operation = '=';
        attributeValues[`:${key}`] = value;
        if (!isQuery && (field === 'granuleId')) {
          expression = `contains(#${field}, :${key})`;
        } else {
          expression = `#${field} ${operation} :${key}`;
        }
      }

      if (isQuery && (field === 'granuleId')) {
        keyConditionArray.push(expression);
      } else {
        filterArray.push(expression);
      }
    });

    return {
      attributeNames,
      attributeValues,
      filterArray,
      filterExpression: (filterArray.length > 0) ? filterArray.join(' AND ') : undefined,
      keyConditionArray,
    };
  }

  /**
   * return all granules filtered by given search params
   *
   * @param {Object} searchParams - optional, search parameters
   * @returns {Array<Object>} the granules' queue for a given collection
   */
  granuleAttributeScan(searchParams) {
    const {
      attributeNames,
      attributeValues,
      filterExpression,
    } = this.getDynamoDbSearchParams(searchParams, false);

    const projectionArray = [];
    const fields = ['granuleId', 'collectionId', 'createdAt', 'beginningDateTime',
      'endingDateTime', 'status', 'updatedAt', 'published', 'provider'];
    fields.forEach((field) => {
      attributeNames[`#${field}`] = field;
      projectionArray.push(`#${field}`);
    });

    const params = {
      TableName: this.tableName,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: filterExpression ? attributeValues : undefined,
      ProjectionExpression: projectionArray.join(', '),
      FilterExpression: filterExpression,
    };

    return new GranuleSearchQueue(removeNilProperties(params));
  }

  /**
   * Delete a granule record and remove its files from S3.
   *
   * @param {Object} granule - A granule record
   * @returns {Promise}
   * @private
   */
  async _deleteRecord(granule) {
    return await super.delete({ granuleId: granule.granuleId });
  }

  /**
   * Delete a granule
   *
   * @param {Object} granule record
   * @returns {Promise}
   */
  async delete(granule) {
    if (granule.published) {
      throw new DeletePublishedGranule('You cannot delete a granule that is published to CMR. Remove it from CMR first');
    }

    return await this._deleteRecord(granule);
  }

  /**
   * Only used for tests
   */
  async deleteGranules() {
    const granules = await this.scan();
    return await Promise.all(granules.Items.map((granule) =>
      this.delete(granule)));
  }

  /**
   * Get the set of fields which are mutable based on the granule status.
   *
   * @param {Object} record - A granule record
   * @returns {Array} - The array of mutable field names
   */
  _getMutableFieldNames(record) {
    if (record.status === 'running') {
      return ['createdAt', 'updatedAt', 'timestamp', 'status', 'execution'];
    }
    return Object.keys(record);
  }

  /**
   * Store a granule record in DynamoDB.
   *
   * @param {Object} granuleRecord - A granule record.
   * @returns {Promise<Object|undefined>}
   */
  async _storeGranuleRecord(granuleRecord) {
    const mutableFieldNames = this._getMutableFieldNames(granuleRecord);
    const updateParams = this._buildDocClientUpdateParams({
      item: granuleRecord,
      itemKey: { granuleId: granuleRecord.granuleId },
      mutableFieldNames,
    });

    // createdAt comes from cumulus_meta.workflow_start_time
    // records should *not* be updating from createdAt times that are *older* start
    // times than the existing record, whatever the status
    updateParams.ConditionExpression = '(attribute_not_exists(createdAt) or :createdAt >= #createdAt)';

    // Only allow "running" granule to replace completed/failed
    // granule if the execution has changed for granules with executions.
    if (granuleRecord.status === 'running' && granuleRecord.execution !== undefined) {
      updateParams.ConditionExpression += ' and #execution <> :execution';
    }

    try {
      return await this.dynamodbDocClient.update(updateParams).promise();
    } catch (error) {
      if (error.name && error.name.includes('ConditionalCheckFailedException')) {
        logger.error(`Did not process delayed event for granule: ${granuleRecord.granuleId} (execution: ${granuleRecord.execution}), cause:`, error);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Validate and store a granule record.
   *
   * @param {Object} granuleRecord - A granule record.
   * @returns {Promise}
   */
  async _validateAndStoreGranuleRecord(granuleRecord) {
    // TODO: Refactor this all to use model.update() to avoid having to manually call
    // schema validation and the actual client.update() method.
    await this.constructor.recordIsValid(granuleRecord, this.schema, this.removeAdditional);
    return this._storeGranuleRecord(granuleRecord);
  }

  /**
   * Stores a granule in dynamoDB
   *
   * @param {Object} granuleRecord - dynamoDB granule
   * @returns {Object} dynamodbDocClient update responses
   */
  async storeGranule(granuleRecord) {
    logger.info(`About to write granule with granuleId ${granuleRecord.granuleId}, collectionId ${granuleRecord.collectionId} to DynamoDB`);
    const response = await this._validateAndStoreGranuleRecord(granuleRecord);
    logger.info(`Successfully wrote granule with granuleId ${granuleRecord.granuleId}, collectionId ${granuleRecord.collectionId} to DynamoDB`);
    return response;
  }

  async describeGranuleExecution(executionArn) {
    let executionDescription;
    try {
      executionDescription = await this.stepFunctionUtils.describeExecution({
        executionArn,
      });
    } catch (error) {
      logger.error(`Could not describe execution ${executionArn}`, error);
    }
    return executionDescription;
  }

  /**
   * Generate and store granule records from a Cumulus message.
   *
   * @param {Object} cumulusMessage - Cumulus workflow message
   * @returns {Promise}
   */
  async storeGranulesFromCumulusMessage(cumulusMessage) {
    const granules = getMessageGranules(cumulusMessage);
    if (granules.length === 0) {
      logger.info(`No granules to process in the payload: ${JSON.stringify(cumulusMessage.payload)}`);
      return granules;
    }

    const executionArn = getMessageExecutionArn(cumulusMessage);
    const executionUrl = getExecutionUrlFromArn(executionArn);
    const executionDescription = await this.describeGranuleExecution(executionArn);
    const processingTimeInfo = getExecutionProcessingTimeInfo(executionDescription);
    const provider = getMessageProvider(cumulusMessage);
    const workflowStartTime = getMessageWorkflowStartTime(cumulusMessage);
    const collectionId = getCollectionIdFromMessage(cumulusMessage);
    const pdrName = getMessagePdrName(cumulusMessage);
    const error = parseException(cumulusMessage.exception);
    const workflowStatus = getMetaStatus(cumulusMessage);
    const queryFields = getGranuleQueryFields(cumulusMessage);
    const esClient = await Search.es();

    return await Promise.all(granules.map(
      async (granule) => {
        const files = await this.fileUtils.buildDatabaseFiles({
          s3: awsClients.s3(),
          providerURL: buildURL(provider),
          files: granule.files || [],
        }).catch((filesError) => logger.error(filesError));
        const timeToArchive = getGranuleTimeToArchive(granule);
        const timeToPreprocess = getGranuleTimeToPreprocess(granule);
        const productVolume = getGranuleProductVolume(files);
        const now = Date.now();
        const duration = getWorkflowDuration(workflowStartTime, now);
        const status = getGranuleStatus(workflowStatus, granule);

        const granuleRecord = await generateGranuleApiRecord({
          granule,
          executionUrl,
          collectionId,
          provider: provider.id,
          workflowStartTime,
          files,
          error,
          pdrName,
          workflowStatus,
          timeToArchive,
          timeToPreprocess,
          productVolume,
          duration,
          status,
          processingTimeInfo,
          queryFields,
          cmrUtils: this.cmrUtils,
          timestamp: now,
          updatedAt: now,
        }).catch((writeError) => logger.error(writeError));
        await this.storeGranule(granuleRecord)
          .catch((writeError) => logger.error(writeError));
        await indexGranule(esClient, granuleRecord, process.env.ES_INDEX)
          .catch((esError) => logger.error(esError));
      }
    ));
  }
}

module.exports = Granule;
