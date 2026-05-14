import axios from 'axios';
import { cloudServerUrl, serverAppId } from '../../Utils.js';
export default async function getDocument(request) {
  const serverUrl = cloudServerUrl; //process.env.SERVER_URL;
  const docId = request.params.docId;
  const include = request?.params?.include || '';
  const sessiontoken = request?.headers?.sessiontoken || '';
  try {
    if (docId) {
      try {
        const query = new Parse.Query('contracts_Document');
        query.equalTo('objectId', docId);
        query.include('ExtUserPtr');
        query.include('ExtUserPtr.TenantId');
        query.include('CreatedBy');
        query.include('Signers');
        query.include('AuditTrail.UserPtr');
        query.include('Placeholders');
        query.include('DeclineBy');
        query.notEqualTo('IsArchive', true);
        if (include) {
          query?.include(include);
        }
        const res = await query.first({ useMasterKey: true });
        if (res) {
          const IsEnableOTP = res?.get('IsEnableOTP') || false;
          const document = JSON.parse(JSON.stringify(res));
          delete document.ExtUserPtr.TenantId.FileAdapters;
          delete document?.ExtUserPtr?.TenantId?.PfxFile;
          if (!IsEnableOTP) {
            // Unauthenticated guest access: strip sensitive fields
            if (document.ExtUserPtr) {
              document.ExtUserPtr = {
                objectId: document.ExtUserPtr.objectId,
                SignatureType: document.ExtUserPtr.SignatureType,
                UserId: document.ExtUserPtr.UserId ? { objectId: document.ExtUserPtr.UserId.objectId } : undefined,
                Email: document.ExtUserPtr.Email,
                Phone: document.ExtUserPtr.Phone,
                Name: document.ExtUserPtr.Name,
                Company: document.ExtUserPtr.Company,
                HeaderDocId: document.ExtUserPtr.HeaderDocId,
                DownloadFilenameFormat: document.ExtUserPtr.DownloadFilenameFormat,
              };
            }
            if (document.AuditTrail && Array.isArray(document.AuditTrail)) {
              document.AuditTrail = document.AuditTrail.map(entry => ({
                Activity: entry.Activity,
                UserPtr: entry.UserPtr ? { objectId: entry.UserPtr.objectId } : undefined,
                createdAt: entry.createdAt,
              }));
            }
            delete document.Note;
            delete document.Bcc;
            delete document.CreatedBy;
            return document;
          } else {
            if (sessiontoken) {
              try {
                const userRes = await axios.get(serverUrl + '/users/me', {
                  headers: {
                    'X-Parse-Application-Id': serverAppId,
                    'X-Parse-Session-Token': sessiontoken,
                  },
                });
                const userId = userRes.data && userRes.data?.objectId;
                const acl = res.getACL();
                if (userId && acl && acl.getReadAccess(userId)) {
                  return document;
                } else {
                  return { error: "You don't have access of this document!" };
                }
              } catch (err) {
                console.log('err user in not authenticated', err);
                return { error: "You don't have access of this document!" };
              }
            } else {
              return { error: "You don't have access of this document!" };
            }
          }
        } else {
          return { error: "document deleted or you don't have access." };
        }
      } catch (err) {
        console.log('err', err);
        return err;
      }
    } else {
      return { error: 'Please pass required parameters!' };
    }
  } catch (err) {
    console.log('err', err);
    if (err.code == 209) {
      return { error: 'Invalid session token' };
    } else {
      return { error: "You don't have access of this document!" };
    }
  }
}
