// One S3 client factory, because the credential choice below is a trap that was
// already paid for once.
//
// The default AWS_ACCESS_KEY_ID pair in the environment was rotated out at some
// point and nobody noticed, because nothing on the site reads from S3 on a page a
// visitor would load. Anything presigned or fetched with it gets 403
// InvalidAccessKeyId, which silently broke *every* scorecard photo upload until the
// OCR wizard happened to surface it. S3_LOGS_STORAGE_* is the live pair.
//
// The selection used to be copy-pasted into /sign-s3 and scorecardOcrController, and
// this module now adds a third reader (the scorecard photo route). Three copies of a
// credential fallback is how one of them gets missed the next time a key rotates.
//
// `undefined` credentials is not "no credentials" — it tells the SDK to run its own
// provider chain (env, then the Cloud Run metadata service), which is the correct
// behaviour if the S3_LOGS_STORAGE_* pair is ever removed in favour of a task role.

const { S3Client } = require('@aws-sdk/client-s3');

const REGION = 'eu-west-1';

// Built per call rather than memoised at require time: the tests set the env vars
// after loading the module, and a cached client would pin whatever was there first.
function s3Client() {
  return new S3Client({
    region: REGION,
    credentials: process.env.S3_LOGS_STORAGE_KEY
      ? {
          accessKeyId: process.env.S3_LOGS_STORAGE_KEY,
          secretAccessKey: process.env.S3_LOGS_STORAGE_SECRET,
        }
      : undefined,
  });
}

module.exports = { s3Client, REGION };
