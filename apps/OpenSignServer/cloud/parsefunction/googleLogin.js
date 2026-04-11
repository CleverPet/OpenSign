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

  // Verify the token was issued for our client
  const expectedClientId = process.env.GOOGLE_CLIENT_ID;
  if (expectedClientId && tokenInfo.aud !== expectedClientId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Token was not issued for this application');
  }

  if (!tokenInfo.email) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Could not get email from Google token');
  }

  const email = tokenInfo.email.toLowerCase();
  const name = tokenInfo.name || '';

  // Restrict to allowed domain
  const allowedDomain = process.env.GOOGLE_SSO_ALLOWED_DOMAIN;
  if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `Only @${allowedDomain} accounts are allowed`
    );
  }

  // Find existing user by email
  const userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('email', email);
  let user = await userQuery.first({ useMasterKey: true });

  if (!user) {
    // Create new user
    user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('name', name);
    user.set('emailVerified', true);
    user.set('password', crypto.randomBytes(32).toString('hex'));
    await user.signUp(null, { useMasterKey: true });
  }

  if (!user.get('emailVerified')) {
    user.set('emailVerified', true);
    await user.save(null, { useMasterKey: true });
  }

  // Create a session directly
  const sessionToken = 'r:' + crypto.randomBytes(24).toString('hex');
  const Session = Parse.Object.extend('_Session');
  const session = new Session();
  session.set('user', user);
  session.set('sessionToken', sessionToken);
  session.set('createdWith', { action: 'login', authProvider: 'google' });
  session.set('restricted', false);
  session.set('expiresAt', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
  await session.save(null, { useMasterKey: true });

  return { sessionToken, ...user.toJSON() };
}
