import axios from 'axios';

export default async function googleLogin(request) {
  const { id_token } = request.params;

  if (!id_token) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'id_token is required');
  }

  // Verify the id_token with Google's tokeninfo endpoint
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
  const googleSub = tokenInfo.sub;
  const name = tokenInfo.name || '';

  // Restrict to allowed domain if configured
  const allowedDomain = process.env.GOOGLE_SSO_ALLOWED_DOMAIN;
  if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `Only @${allowedDomain} accounts are allowed`
    );
  }

  // Try to find existing user by email
  const userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('email', email);
  const existingUser = await userQuery.first({ useMasterKey: true });

  if (existingUser) {
    // Link Google auth data to existing user
    existingUser.set('authData', {
      google: { id: googleSub, id_token }
    });
    if (!existingUser.get('emailVerified')) {
      existingUser.set('emailVerified', true);
    }
    await existingUser.save(null, { useMasterKey: true });

    // Create a session for this user
    const sessionToken = existingUser.getSessionToken();
    if (sessionToken) {
      return { sessionToken, ...existingUser.toJSON() };
    }

    // Generate a new session via logInWith
    const user = await Parse.User.logInWith('google', {
      authData: { id: googleSub, id_token }
    });
    return { sessionToken: user.getSessionToken(), ...user.toJSON() };
  }

  // No existing user — create one
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('name', name);
  user.set('emailVerified', true);
  user.set('authData', {
    google: { id: googleSub, id_token }
  });

  const crypto = await import('node:crypto');
  user.set('password', crypto.randomBytes(32).toString('hex'));

  await user.signUp(null, { useMasterKey: true });

  return { sessionToken: user.getSessionToken(), ...user.toJSON() };
}
