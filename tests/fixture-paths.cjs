const {join}=require('node:path');
const local=join(__dirname,'..','.local');
exports.upstreamDir=process.env.LWL_UPSTREAM_DIR || join(local,'upstream');
exports.organizerDir=process.env.LWL_ORGANIZER_DIR || join(local,'organizer');
