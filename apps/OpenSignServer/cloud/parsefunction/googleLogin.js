import axios from 'axios';
import crypto from 'node:crypto';

export default async function googleLogin(request) {
  const { id_token } = request.params;

  if (!id_token) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'id_token is required');
  }

  // Verify the id_token with Google
  let tokenInfo;
  try {
    const { data } = await axios.get(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`
    );
    tokenInfo = data;
  } catch (err) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Invalid Google id_token');
  }

  const expectedClientId = process.env.GOOGLE_CLIENT_ID;
  if (!expectedClientId) {
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'GOOGLE_CLIENT_ID not configured');
  }
  if (tokenInfo.aud !== expectedClientId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Token was not issued for this application');
  }

  if (!tokenInfo.email) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Could not get email from Google token');
  }

  const email = tokenInfo.email.toLowerCase();
  const name = tokenInfo.name || email.split('@')[0];

  const allowedDomain = process.env.GOOGLE_SSO_ALLOWED_DOMAIN;
  if (!allowedDomain) {
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'GOOGLE_SSO_ALLOWED_DOMAIN not configured');
  }
  if (!email.endsWith(`@${allowedDomain}`)) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `Only @${allowedDomain} accounts are allowed`
    );
  }

  // Find or create the Parse _User
  const userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('email', email);
  let user = await userQuery.first({ useMasterKey: true });

  const tempPassword = crypto.randomBytes(32).toString('hex');

  if (!user) {
    user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('name', name);
    user.set('emailVerified', true);
    user.set('password', tempPassword);
    await user.signUp(null, { useMasterKey: true });
    console.log('Created new Parse user for', email);
  } else {
    user.set('password', tempPassword);
    if (!user.get('emailVerified')) {
      user.set('emailVerified', true);
    }
    await user.save(null, { useMasterKey: true });
  }

  // Ensure contracts_Users entry exists (required by thirdpartyLoginfn / getUserDetails)
  const ExtUsers = Parse.Object.extend('contracts_Users');
  const extQuery = new Parse.Query(ExtUsers);
  extQuery.equalTo('UserId', {
    __type: 'Pointer',
    className: '_User',
    objectId: user.id,
  });
  let extUser = await extQuery.first({ useMasterKey: true });

  if (!extUser) {
    // Find an existing tenant to link to (use the first one — single-tenant deployment)
    const Tenant = Parse.Object.extend('partners_Tenant');
    const tenantQuery = new Parse.Query(Tenant);
    tenantQuery.ascending('createdAt');
    let tenant = await tenantQuery.first({ useMasterKey: true });

    if (!tenant) {
      // No tenant exists — create one for this user
      tenant = new Tenant();
      tenant.set('UserId', { __type: 'Pointer', className: '_User', objectId: user.id });
      tenant.set('TenantName', 'FluentPet');
      tenant.set('EmailAddress', email);
      tenant.set('IsActive', true);
      tenant.set('CreatedBy', { __type: 'Pointer', className: '_User', objectId: user.id });
      await tenant.save(null, { useMasterKey: true });
      console.log('Created new tenant for', email);
    }

    // Find existing org and default team (single-tenant deployment)
    const orgQuery = new Parse.Query('contracts_Organizations');
    orgQuery.ascending('createdAt');
    const org = await orgQuery.first({ useMasterKey: true });

    const teamQuery = new Parse.Query('contracts_Teams');
    teamQuery.equalTo('Name', 'All Users');
    const defaultTeam = await teamQuery.first({ useMasterKey: true });

    // Create contracts_Users entry — default role is User, not Admin
    extUser = new ExtUsers();
    extUser.set('UserId', { __type: 'Pointer', className: '_User', objectId: user.id });
    extUser.set('UserRole', 'contracts_User');
    extUser.set('Email', email);
    extUser.set('Name', name);
    extUser.set('TenantId', { __type: 'Pointer', className: 'partners_Tenant', objectId: tenant.id });
    if (org) {
      extUser.set('OrganizationId', { __type: 'Pointer', className: 'contracts_Organizations', objectId: org.id });
    }
    if (defaultTeam) {
      extUser.set('TeamIds', [{ __type: 'Pointer', className: 'contracts_Teams', objectId: defaultTeam.id }]);
    }
    const extAcl = new Parse.ACL();
    extAcl.setPublicReadAccess(true);
    extAcl.setPublicWriteAccess(false);
    extAcl.setReadAccess(user.id, true);
    extAcl.setWriteAccess(user.id, true);
    extUser.setACL(extAcl);
    await extUser.save(null, { useMasterKey: true });
    console.log('Created contracts_Users entry for', email, '(role: contracts_User)');
  }

  // Log in with the temp password to create a proper session
  const loggedInUser = await Parse.User.logIn(email, tempPassword);

  return { sessionToken: loggedInUser.getSessionToken(), ...loggedInUser.toJSON() };
}
