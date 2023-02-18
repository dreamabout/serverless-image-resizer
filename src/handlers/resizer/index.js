'use strict';

const AWS = require('aws-sdk');
const S3 = new AWS.S3({
  signatureVersion: 'v4',
});
const Sharp = require('sharp');

const BUCKET = process.env.BUCKET;
const URL = process.env.URL;

function getResizeFunc(version, format, width, height, fit = 'contain', resizeOptions = {}, keepAlpha = false) {
  switch (version) {
    default:
    case 2:
    case 3:
      return async (data) => {
        const image = Sharp(data.Body);
        let alpha = 1;
        if(keepAlpha) {
          const metadata = await image.metadata();
          alpha = (metadata.hasAlpha ? 0 : 1);
        }
        
        let formatOptions = {};
        let background = {
          r: 255,
          g: 255,
          b: 255,
          alpha: alpha
        };
        let flattenedBackground = {background: '#FFFFFF'};
        switch (format) {
          case 'png':
            formatOptions = {progressive: true};
            break;
          case 'jpg':
            background = {
              r: 255,
              g: 255,
              b: 255,
            }
            formatOptions = {progressive: true, mozjpeg: true};
        }
        if (keepAlpha) {
          return image
          .resize(width || null, height || null, Object.assign({}, {
            fit: fit,
            background: background,
            fastShrinkOnLoad: false,
          }, resizeOptions))
          .toFormat(format, formatOptions).toBuffer({resolveWithObject: true});
        } 
        return image
          .resize(width || null, height || null, Object.assign({}, {
            fit: fit,
            background: background,
            fastShrinkOnLoad: false,
          }, resizeOptions))
          .flatten(flattenedBackground)
          .toFormat(format, formatOptions).toBuffer({resolveWithObject: true});
      }
      break;
    case 1:
      return async (data) => {
        return Sharp(data.Body).resize(width || null, height || null).toBuffer({resolveWithObject: true});
      }
  }
}

function debug(message) {
  process.env.DEBUG && console.log(message);
}

exports.handler = function (event, context, callback) {
  let regexp = new RegExp(
    '^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/((?<version>\\d{1})?/?)(images/)?(?<folder>products|blocks)/(?<width>\\d{1,4}[.\\d]{0,2})/(?<height>\\d{1,4}[.\\d]{0,2})/(?<path>[\\w\\.\\-]+)$', "i"
  );
  const maxAge = 90 * 24 * 60 * 60;
  const key = event.queryStringParameters.key;
  const keepAlpha = event.queryStringParameters.keepAlpha || false;
  let originalKey = '';
  let match = key.match(regexp);
  let ContentType = '';
  const redirectKey = key.replace(/^\/*/, '');
  debug({"msg": "Seeing if it matches resize request", key, match, regexp})
  if (match === null) {
    regexp = new RegExp("^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/files/(?<fileId>\\d{1,3})/(?<path>[\\w\\.\\-]+)$");
    match = key.match(regexp);
    if (match === null) {
      regexp = new RegExp("^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/((?<version>\\d{1})?/?)images/(?<folder>[^/]+)/(?<path>[\\w\\.\\-]+)$");
      match = key.match(regexp);
      let path = match.groups.path;
      let pathParts = path.split('.');
      let format = pathParts[pathParts.length - 1];
      if (pathParts.length > 2) {
        format = pathParts.pop();
        path = pathParts.join('.');
      }
      let version = match.groups.version || 0;
      let width = 2000;
      let resizeFunc = getResizeFunc(version, format, width, 0, 'inside', {withoutEnlargement: true}, keepAlpha);
      originalKey = "catalog/" + match.groups.folder + "/images/" + path;
      return S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
        .then(resizeFunc)
        .then(buffer =>
          S3.putObject({
            Body: buffer.data,
            ContentType: (buffer.info || {format: "image/jpeg"}).format,
            Bucket: BUCKET,
            Key: key,
            CacheControl: `max-age=${maxAge}`,
          }).promise()
        )
        .then(() =>
          callback(null, {
            statusCode: '301',
            headers: {
              'location': `${URL}${redirectKey}`,
              'Cache-Control': "max-age=0",
            },
            body: '',
          })
        ).catch(err => {
          console.log(`Could not find key: ${originalKey}`);
          callback(err);
        });
    } else {
      originalKey = "files/" + match.groups.fileId + "/" + match.groups.path;
      ContentType = 'application/octet-stream';
      return S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
        .then(data =>
          S3.putObject({
            Body: data.Body,
            Bucket: BUCKET,
            Key: key,
            CacheControl: `max-age=${maxAge}`,
            ContentType: ContentType
          }).promise()
        )
        .then(() =>
          callback(null, {
            statusCode: '301',
            headers: {
              'location': `${URL}${redirectKey}`,
              'Cache-Control': "max-age=0",
            },
            body: '',
          })
        ).catch(err => {
          console.log(`Could not find key: ${originalKey}`);
          callback(err);
        });
    }
  }
  let width = parseInt(match.groups.width, 10);
  let height = parseInt(match.groups.height, 10);
  if (width === 0 && height === 0) {
    width = 2560;
  }
  let path = match.groups.path;
  let pathParts = path.split('.');
  let format = pathParts[pathParts.length - 1];
  if (pathParts.length > 2) {
    format = pathParts.pop();
    path = pathParts.join('.');
  }
  const folder = match.groups.folder;
  originalKey = "catalog/" + folder + "/images/" + path;
  let version = parseInt(match.groups.version || 1, 10);
  let resizeFunc = getResizeFunc(version, format, width, height);
  debug({version, path, folder, width, height, originalKey, format, matchGroups: match.groups});
  S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
    .then(resizeFunc)
    .then(buffer => S3.putObject({
        Body: buffer.data,
        Bucket: BUCKET,
        ContentType: (buffer.info || {format: "image/jpeg"}).format,
        Key: key,
        CacheControl: `max-age=${maxAge}`
      }).promise()
    )
    .then(() => callback(null, {
        statusCode: '301',
        headers: {
          'location': `${URL}${redirectKey}`,
          "Cache-Control": "max-age=0",
        },
        body: '',
      })
    )
    .catch(err => callback(err))
}
