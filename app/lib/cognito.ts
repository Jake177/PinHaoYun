"use client";

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
} from "amazon-cognito-identity-js";

// Best practice: for public web apps, use an App Client WITHOUT a client secret.
// Configure values via .env.local (see .env.example). Do not hardcode IDs in code.
const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

if (!userPoolId || !clientId) {
  throw new Error(
    "Missing Cognito env. Set NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID in .env.local"
  );
}

const userPool = new CognitoUserPool({
  UserPoolId: userPoolId,
  ClientId: clientId,
});

export type SignUpPayload = {
  email: string;
  password: string;
  preferredUsername: string;
  givenName: string;
  familyName: string;
  gender: "Male" | "Female" | "Other";
};

export type SignInPayload = {
  email: string;
  password: string;
};

export const signUpUser = (payload: SignUpPayload) =>
  new Promise<CognitoUser | undefined>((resolve, reject) => {
    const attributes = [
      new CognitoUserAttribute({ Name: "email", Value: payload.email }),
      new CognitoUserAttribute({
        Name: "preferred_username",
        Value: payload.preferredUsername,
      }),
      new CognitoUserAttribute({ Name: "given_name", Value: payload.givenName }),
      new CognitoUserAttribute({
        Name: "family_name",
        Value: payload.familyName,
      }),
      new CognitoUserAttribute({ Name: "gender", Value: payload.gender }),
    ];

    userPool.signUp(
      payload.email,
      payload.password,
      attributes,
      [],
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result?.user);
      },
    );
  });

export type SignInResult = {
  session: CognitoUserSession;
  user: CognitoUser;
};

export const signInUser = (payload: SignInPayload) =>
  new Promise<SignInResult>((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: payload.email,
      Pool: userPool,
    });

    const authDetails = new AuthenticationDetails({
      Username: payload.email,
      Password: payload.password,
    });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session) => resolve({ session, user: cognitoUser }),
      onFailure: (error) => reject(error),
      newPasswordRequired: () =>
        reject(new Error("该账号需要管理员设置临时密码后首次登录修改密码。")),
    });
  });
