import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { v4 } from 'uuid';
import jwt from 'jsonwebtoken';
import validator from 'validator';
import { getConfig } from '../../core/TipiConfig';
import TipiCache from '../../core/TipiCache';
import { fileExists, unlinkFile } from '../../common/fs.helpers';

type UsernamePasswordInput = {
  username: string;
  password: string;
};

type TokenResponse = {
  token: string;
};

export class AuthServiceClass {
  private prisma;

  constructor(p: PrismaClient) {
    this.prisma = p;
  }

  /**
   * Authenticate user with given username and password
   *
   * @param {UsernamePasswordInput} input - An object containing the user's username and password
   * @returns {Promise<{token:string}>} - A promise that resolves to an object containing the JWT token
   */
  public login = async (input: UsernamePasswordInput) => {
    const { password, username } = input;

    const user = await this.prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });

    if (!user) {
      throw new Error('User not found');
    }

    const isPasswordValid = await argon2.verify(user.password, password);

    if (!isPasswordValid) {
      throw new Error('Wrong password');
    }

    const session = v4();
    const token = jwt.sign({ id: user.id, session }, getConfig().jwtSecret, { expiresIn: '7d' });

    await TipiCache.set(session, user.id.toString());

    return { token };
  };

  /**
   * Creates a new user with the provided email and password and returns a session token
   *
   * @param {UsernamePasswordInput} input - An object containing the email and password fields
   * @returns {Promise<{token: string}>} - An object containing the session token
   * @throws {Error} - If the email or password is missing, the email is invalid or the user already exists
   */
  public register = async (input: UsernamePasswordInput) => {
    const registeredUser = await this.prisma.user.findFirst({ where: { operator: true } });

    if (registeredUser) {
      throw new Error('There is already an admin user. Please login to create a new user from the admin panel.');
    }

    const { password, username } = input;
    const email = username.trim().toLowerCase();

    if (!username || !password) {
      throw new Error('Missing email or password');
    }

    if (username.length < 3 || !validator.isEmail(email)) {
      throw new Error('Invalid username');
    }

    const user = await this.prisma.user.findUnique({ where: { username: email } });

    if (user) {
      throw new Error('User already exists');
    }

    const hash = await argon2.hash(password);
    const newUser = await this.prisma.user.create({ data: { username: email, password: hash, operator: true } });

    const session = v4();
    const token = jwt.sign({ id: newUser.id, session }, getConfig().jwtSecret, { expiresIn: '1d' });

    await TipiCache.set(session, newUser.id.toString());

    return { token };
  };

  /**
   * Retrieves the user with the provided ID
   *
   * @param {number|undefined} userId - The user ID to retrieve
   * @returns {Promise<{id: number, username: string} | null>} - An object containing the user's id and email, or null if the user is not found
   */
  public me = async (userId: number | undefined) => {
    if (!userId) return null;

    const user = await this.prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, username: true } });

    if (!user) return null;

    return user;
  };

  /**
   * Logs out the current user by removing the session token
   *
   * @param {string} [session] - The session token to log out
   * @returns {Promise<boolean>} - Returns true if the session token is removed successfully
   */
  public static logout = async (session?: string): Promise<boolean> => {
    if (session) {
      await TipiCache.del(session);
    }

    return true;
  };

  /**
   * Refreshes a user's session token
   *
   * @param {string} [session] - The current session token
   * @returns {Promise<{token: string} | null>} - An object containing the new session token, or null if the session is invalid
   */
  public static refreshToken = async (session?: string): Promise<TokenResponse | null> => {
    if (!session) return null;

    const userId = await TipiCache.get(session);
    if (!userId) return null;

    // Expire token in 6 seconds
    await TipiCache.set(session, userId, 6);

    const newSession = v4();
    const token = jwt.sign({ id: userId, session: newSession }, getConfig().jwtSecret, { expiresIn: '1d' });
    await TipiCache.set(newSession, userId);

    return { token };
  };

  /**
   * Check if the system is configured and has at least one user
   *
   * @returns {Promise<boolean>} - A boolean indicating if the system is configured or not
   */
  public isConfigured = async (): Promise<boolean> => {
    const count = await this.prisma.user.count({ where: { operator: true } });

    return count > 0;
  };

  /**
   * Change the password of the operator user
   *
   * @param {object} params - An object containing the new password
   * @param {string} params.newPassword - The new password
   * @returns {Promise<string>} - The username of the operator user
   * @throws {Error} - If the operator user is not found or if there is no password change request
   */
  public changePassword = async (params: { newPassword: string }) => {
    if (!AuthServiceClass.checkPasswordChangeRequest()) {
      throw new Error('No password change request found');
    }

    const { newPassword } = params;
    const user = await this.prisma.user.findFirst({ where: { operator: true } });

    if (!user) {
      throw new Error('Operator user not found');
    }

    const hash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: user.id }, data: { password: hash } });

    await unlinkFile(`/runtipi/state/password-change-request`);

    return { email: user.username };
  };

  /*
   * Check if there is a pending password change request for the given email
   * Returns true if there is a file in the password change requests folder with the given email
   *
   * @returns {boolean} - A boolean indicating if there is a password change request or not
   */
  public static checkPasswordChangeRequest = () => {
    if (fileExists(`/runtipi/state/password-change-request`)) {
      return true;
    }

    return false;
  };

  /*
   * If there is a pending password change request, remove it
   * Returns true if the file is removed successfully
   *
   * @returns {boolean} - A boolean indicating if the file is removed successfully or not
   * @throws {Error} - If the file cannot be removed
   */
  public static cancelPasswordChangeRequest = async () => {
    if (fileExists(`/runtipi/state/password-change-request`)) {
      await unlinkFile(`/runtipi/state/password-change-request`);
    }

    return true;
  };
}
