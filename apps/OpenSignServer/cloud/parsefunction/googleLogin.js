import axios from 'axios';

export default async function googleLogin(request) {
  const { id_token, access_token } = request.params;

  if (!id_token) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'id_token is required');
  }

  // Verify the token and get user info
  const { data: googleUser } = await axios.get(
    'https://www.googleapis.com/oauth2/v3/userinfo',
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  if (!googleUser?.email) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Could not get email from Google');
  }

  const email = googleUser.email.toLowerCase();

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
    // Link Google auth data and return session
    existingUser.set('authData', {
      google: { id: googleUser.sub, id_token, access_token }
    });
    await existingUser.save(null, { useMasterKey: true });

    // Create a new session
    const sessionToken = existingUser.getSessionToken();
    if (sessionToken) {
      return { sessionToken, ...existingUser.toJSON() };
    }

    // If no session token, log in via authData
    const user = await Parse.User.logInWith('google', {
      authData: { id: googleUser.sub, id_token, access_token }
    });
    return { sessionToken: user.getSessionToken(), ...user.toJSON() };
  }

  // Create new user via Google auth
  const user = new Parse.User();
  user.set('username', email);
  user.set('email', email);
  user.set('name', googleUser.name || '');
  user.set('emailVerified', true);
  user.set('authData', {
    google: { id: googleUser.sub, id_token, access_token }
  });

  // Generate a random password (user will auth via Google, not password)
  const crypto = await import('node:crypto');
  user.set('password', crypto.randomBytes(32).toString('hex'));

  await user.signUp(null, { useMasterKey: true });

  return { sessionToken: user.getSessionToken(), ...user.toJSON() };
}
