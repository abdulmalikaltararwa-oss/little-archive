// The import wire contract is independent of application/release versions.
// Version 1 keeps historical batch bodies unchanged, including pending retries.
import {MAX_BATCH_ITEMS,MAX_BATCH_BYTES} from './core.js';

export const PROTOCOL_NAME='little-archive.extension';
export const PROTOCOL_VERSION=1;
export const PROTOCOL_HEADER='X-Little-Archive-Protocol';
export const REQUIRED_CAPABILITIES=Object.freeze([
  'current_view_imports',
  'idempotent_batches',
  'exact_batch_finish',
  'source_collection_memberships',
  'partial_coverage',
]);
const REQUIRED_LIMITS=Object.freeze({max_batch_items:MAX_BATCH_ITEMS,max_batch_bytes:MAX_BATCH_BYTES});
const isObject=value=>Boolean(value) && typeof value==='object' && !Array.isArray(value);
const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

export class ProtocolCompatibilityError extends Error {
  constructor(code,message) {
    super(message);
    this.name='ProtocolCompatibilityError';
    this.code=code;
    this.status=409;
  }
}

export function runProtocolVersion(run) {
  // A missing field identifies the original checkpoint format, whose wire
  // payload is version 1. This does not rewrite or recreate any queued body.
  const version=run && owns(run,'protocolVersion') ? run.protocolVersion : PROTOCOL_VERSION;
  if (version!==PROTOCOL_VERSION) {
    throw new ProtocolCompatibilityError('checkpoint_protocol_unsupported',
      'This scan uses an unsupported import protocol. Keep this browser profile and its pending batches; install an extension compatible with the scan before resuming.');
  }
  return version;
}

export function negotiateProtocol(info,requestedVersion=PROTOCOL_VERSION) {
  runProtocolVersion({protocolVersion:requestedVersion});
  if (!isObject(info) || info.ok!==true || typeof info.instance_id!=='string' || !info.instance_id || info.instance_id.length>200) {
    throw new ProtocolCompatibilityError('invalid_server_status',
      'The server did not return a valid Little Archive status. Check the instance address or update the server. Pending batches are unchanged.');
  }
  const serverVersion=typeof info.version==='string' && info.version.length<=80 ? info.version : '';
  if (!owns(info,'extension_protocol')) {
    // Only the immediately preceding, known 0.1.0 status shape is supported.
    // Never infer compatibility for unknown releases or an invalid declaration.
    if (serverVersion==='0.1.0') {
      return {version:PROTOCOL_VERSION,mode:'legacy',serverVersion};
    }
    throw new ProtocolCompatibilityError('server_protocol_missing',
      'This server does not advertise a supported import protocol. Update Little Archive on the server, then retry. Pending batches are unchanged.');
  }
  const protocol=info.extension_protocol;
  if (!isObject(protocol) || protocol.name!==PROTOCOL_NAME || !isObject(protocol.versions)) {
    throw new ProtocolCompatibilityError('invalid_protocol_declaration',
      'The server returned an invalid import-protocol declaration. Update the server or use a compatible extension. Pending batches are unchanged.');
  }
  const version=protocol.versions[String(requestedVersion)];
  if (!owns(protocol.versions,String(requestedVersion)) || !isObject(version)) {
    throw new ProtocolCompatibilityError('server_protocol_unsupported',
      'The extension and server have no supported import protocol in common. Update them to compatible releases, then retry. Pending batches are unchanged.');
  }
  if (!Array.isArray(version.capabilities) || version.capabilities.length>100 ||
      version.capabilities.some(value=>typeof value!=='string') ||
      REQUIRED_CAPABILITIES.some(capability=>!version.capabilities.includes(capability))) {
    throw new ProtocolCompatibilityError('server_capabilities_missing',
      'The server is missing required import capabilities. Update the server before importing or retrying. Pending batches are unchanged.');
  }
  if (!isObject(version.limits) || Object.entries(REQUIRED_LIMITS).some(([key,minimum])=>
    !Number.isSafeInteger(version.limits[key]) || version.limits[key]<minimum)) {
    throw new ProtocolCompatibilityError('server_limits_incompatible',
      'The server cannot accept this extension’s version 1 batch limits. Use compatible releases before retrying; queued batches will not be split or rewritten.');
  }
  return {version:requestedVersion,mode:'negotiated',serverVersion};
}

export function protocolHeaders(protocol) {
  runProtocolVersion({protocolVersion:protocol?.version});
  if (protocol.mode==='legacy') return {};
  if (protocol.mode!=='negotiated') {
    throw new ProtocolCompatibilityError('protocol_not_negotiated','Check server compatibility before sending an import. Pending batches are unchanged.');
  }
  return {[PROTOCOL_HEADER]:String(protocol.version)};
}
