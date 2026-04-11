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

  // Generate a one-time password for session creation
  const tempPassword = crypto.randomBytes(32).toString('hex');

  if (!user) {
    // Create new user
    user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('name', name);
    user.set('emailVerified', true);
    user.set('password', tempPassword);
    await user.signUp(null, { useMasterKey: true });
  } else {
    // Set temp password on existing user so we can log in
    user.set('password', tempPassword);
    if (!user.get('emailVerified')) {
      user.set('emailVerified', true);
    }
    await user.save(null, { useMasterKey: true });
  }

  // Log in with the temp password to create a proper session
  const loggedInUser = await Parse.User.logIn(email, tempPassword);

  // Restore a strong random password so the temp one can't be reused
  const finalPassword = crypto.randomBytes(32).toString('hex');
  loggedInUser.set('password', finalPassword);
  await loggedInUser.save(null, { useMasterKey: true });

  return { sessionToken: loggedInUser.getSessionToken(), ...loggedInUser.toJSON() };
}
