import axios from 'axios';

import { DateTime } from 'luxon';
import { myTeamLog } from '../logging';
import { CalendarResponse, SimplifiedItem, SimplifiedAbsence } from './my_team_interfaces';

const URL = process.env['MY_TEAM_URL'];
const EMAIL = process.env['MY_TEAM_EMAIL'];
const PASSWORD = process.env['MY_TEAM_PASSWORD'];

interface CacheItem<T> {
    value: T;
    expiresAt: DateTime;
}

let calendarCache: CacheItem<any> | null = null;

export function simplifyCalendarData(response: CalendarResponse): SimplifiedItem[] {
    const todayStr = DateTime.local().toFormat('dd.MM.yyyy');
  
    return response.data.items
      .map(item => {
        const relevantAbsences: SimplifiedAbsence[] = item.absences
          .filter(abs => abs.date === todayStr)
          .map(abs => ({
            date: abs.date,
            count: Number(abs.count),
            typeName: abs.type.name,
            statusName: abs.status.name,
          }));
  
        if (!relevantAbsences.length) return;
  
        return {
          user: item.user.name,
          absences: relevantAbsences,
        };
      })
      .filter((item): item is SimplifiedItem => Boolean(item));
}

async function getSessionCookie(): Promise<string> {
    myTeamLog.info({ message: 'getSessionCookie start login' });

    const loginResponse = await axios.post(
        `${URL}api/login/`,
        {
        email: EMAIL,
        password: PASSWORD,
        remember: false,
        },
        {
        headers: {
            'Content-Type': 'application/json',
        },
        withCredentials: true,
        }
    );

    const setCookieHeader = loginResponse.headers['set-cookie'];

    if (!setCookieHeader || !setCookieHeader.length) {
        throw new Error('Не удалось получить сессионную куку');
    }

    const sessionCookie = setCookieHeader
        .map(cookie => cookie.split(';')[0])
        .join('; ');

    myTeamLog.info({ message: 'getSessionCookie success' });

    return sessionCookie;
}

export async function getCalendarForCurrentMonth(): Promise<SimplifiedItem[]> {
    try {
        const now = DateTime.local();

        if (calendarCache && calendarCache.expiresAt > now) {
            myTeamLog.info({ message: 'getCalendarForCurrentMonth use cache', expiresAt: calendarCache.expiresAt });
            return calendarCache.value;
        }

        const sessionCookie = await getSessionCookie();
        const from = now.startOf('week').toFormat('dd.MM.yyyy');
        const to = now.endOf('week').toFormat('dd.MM.yyyy');

        myTeamLog.info({ message: 'getCalendarForCurrentMonth start', from, to });

        const calendarResponse = await axios.post<CalendarResponse>(
            `${URL}api/calendars/absences`,
            { from, to },
            {
            headers: {
                'Content-Type': 'application/json',
                Cookie: sessionCookie,
            },
            }
        );

        const items = simplifyCalendarData(calendarResponse.data);

        calendarCache = {
            value: items,
            expiresAt: now.plus({ days: 1 }),
        };

        myTeamLog.info({ message: 'getCalendarForCurrentMonth success' });

        return items;
    } catch (error: any) {
        myTeamLog.error({ message: 'getCalendarForCurrentMonth error', error: error.message });
        return [];;
    }
}
