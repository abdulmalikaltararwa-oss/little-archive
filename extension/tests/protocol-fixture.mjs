// This is the public v1 declaration, with a synthetic instance identity.
export const protocolStatus=()=>({
  ok:true,version:'0.1.0',instance_id:'synthetic-protocol-instance',
  extension_protocol:{name:'little-archive.extension',versions:{'1':{
    capabilities:['current_view_imports','idempotent_batches','exact_batch_finish','source_collection_memberships','partial_coverage'],
    limits:{max_batch_items:50,max_batch_bytes:262144},
  }}},
});
