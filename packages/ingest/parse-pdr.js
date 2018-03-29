/**
 * This module includes tools for validating PDRs
 * and generating PDRD and PAN messages
 */

'use strict';

const fs = require('fs-extra');
const pvl = require('@cumulus/pvl/t');
const { PDRParsingError } = require('@cumulus/common/errors');

function getItem(spec, pdrName, name, must = true) {
  const item = spec.get(name);
  if (item) {
    return item.value;
  }

  if (must) {
    throw new PDRParsingError(name, pdrName);
  }

  return null;
}

/**
 * Makes sure that a FILE Spec has all the required files and returns
 * the content as an object. Throws error if anything is missing
 * For more info refer to https://github.com/cumulus-nasa/cumulus-api/issues/104#issuecomment-285744333
 *
 * @param {object} spec PDR spec object generated by PVL
 * @returns {object} throws error if failed
 */
function parseSpec(pdrName, spec) {
  const get = getItem.bind(null, spec, pdrName);

  // check each file_spec has DIRECTORY_ID, FILE_ID, FILE_SIZE
  const path = get('DIRECTORY_ID');
  const filename = get('FILE_ID');
  const fileSize = get('FILE_SIZE');

  const checksumType = get('FILE_CKSUM_TYPE', false);
  const checksumValue = get('FILE_CKSUM_VALUE', false);

  // if it has cksum, make sure both FILE_CKSUM_TYPE and FILE_CKSUM_VALUE are present
  if (checksumType || checksumValue) {
    if (!checksumType) {
      throw new PDRParsingError('MISSING FILE_CKSUM_TYPE PARAMETER');
    }

    if (!checksumValue) {
      throw new PDRParsingError('MISSING FILE_CKSUM_VALUE PARAMETER');
    }
  }

  // make sure FILE_CKSUM_TYPE value is CKSUM
  if (checksumType && checksumType !== 'CKSUM') {
    throw new PDRParsingError('UNSUPPORTED CHECKSUM TYPE');
  }

  // make sure FILE_CKSUM_VALUE is numeric
  if (checksumValue && typeof checksumValue !== 'number') {
    throw new PDRParsingError('FILE_CKSUM_VALUE', pdrName);
  }

  const parsedSpec = {
    path,
    fileSize,
    name: filename
  };
  if (checksumType) parsedSpec.checksumType = checksumType;
  if (checksumValue) parsedSpec.checksumValue = checksumValue;
  return parsedSpec;
}
module.exports.parseSpec = parseSpec;

function extractGranuleId(fileName, regex) {
  const test = new RegExp(regex);
  const match = fileName.match(test);

  if (match) {
    return match[1];
  }
  return fileName;
}

async function loadPdrFile(pdrFilePath) {
  const pdrFile = await fs.readFile(pdrFilePath, 'utf8');

  // Investigating CUMULUS-423
  if (pdrFile.trim().length === 0) throw new Error(`PDR file had no contents: ${pdrFilePath}`);

  // because MODAPS PDRs do not follow the standard ODL spec
  // we have to make sure there are spaces before and after every
  // question mark
  let pdrString = pdrFile.replace(/((\w*)=(\w*))/g, '$2 = $3');

  // temporary fix for PVL not recognizing quoted strings as symbols
  pdrString = pdrString.replace(/"/g, '');

  let parsed;
  try {
    parsed = pvl.pvlToJS(pdrString);
  }
  catch (e) {
    throw new PDRParsingError(e.message);
  }

  return parsed;
}

function granuleFromFileGroup(fileGroup, granuleIdExtraction, pdrName) {
  if (!fileGroup.get('DATA_TYPE')) throw new PDRParsingError('DATA_TYPE is missing');
  const dataType = fileGroup.get('DATA_TYPE').value;

  // get all the file specs in each group
  const specs = fileGroup.objects('FILE_SPEC');
  // FIXME This is a very generic error
  if (specs.length === 0) throw new Error();

  const files = specs.map(parseSpec.bind(null, pdrName));
  const granuleId = extractGranuleId(files[0].name, granuleIdExtraction);

  return {
    granuleId,
    dataType,
    granuleSize: files.reduce((total, file) => total + file.fileSize, 0),
    files
  };
}

module.exports.parsePdr = async function parsePdr(pdrFilePath, collection, pdrName) {
  let pdrDocument = await loadPdrFile(pdrFilePath);

  // check if the PDR has groups
  // if so, get the objects inside the first group
  // TODO: handle cases where there are more than one group
  const groups = pdrDocument.groups();
  if (groups.length > 0) pdrDocument = groups[0]; // eslint-disable-line prefer-destructuring

  // Get all the file groups
  const fileGroups = pdrDocument.objects('FILE_GROUP');

  const granules = fileGroups.map((fileGroup) =>
    granuleFromFileGroup(fileGroup, collection.granuleIdExtraction, pdrName));

  // check file count
  const filesCount = granules.reduce((total, granule) => total + granule.files.length, 0);
  const expectedFileCount = pdrDocument.get('TOTAL_FILE_COUNT').value;
  if (filesCount !== expectedFileCount) {
    throw new PDRParsingError("FILE COUNT doesn't match expected file count");
  }

  return {
    filesCount,
    granules,
    granulesCount: granules.length,
    totalSize: granules.reduce((total, granule) => total + granule.granuleSize, 0)
  };
};
