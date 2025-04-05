import { DateTime } from 'luxon';

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
// 7 % 7 - это 0 , поэтому воскресенье первое
export const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const timeToMinutes = (time: string): number => {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
};

export const calculateNextRunDate = (time: string, days: string[]): number => {
    const now = DateTime.now().setZone('Europe/Moscow');
    const [hour, minute] = time.split(':').map(Number);
    const currentDayIndex = now.weekday % 7; // Luxon: 1 - понедельник, 0 - воскресенье
    const currentTime = now.toFormat('HH:mm');
    const currentMinutes = timeToMinutes(currentTime);
    const reminderMinutes = timeToMinutes(time);

    const reminderDate = now.set({ hour, minute });

    // Если пятница и время прошло — переход на понедельник
    if (now.weekday === 5 && currentMinutes > reminderMinutes) {
        if (!days.length || days.every(day => WEEK_DAYS.includes(day))) {
            // toMillis - выводит в UTC
            return reminderDate.plus({ days: 3 }).toMillis(); // Пятница -> Понедельник
        }
    }

    // Если дни не указаны — используем ближайший рабочий день
    const activeDays = days.length ? days : WEEK_DAYS;
    // Если текущий день не входит в указанные — ищем ближайший из списка
    const currentDayName = ALL_DAYS[currentDayIndex];
    const checker = !activeDays.includes(currentDayName) || currentMinutes > reminderMinutes;

    if (!checker) {
        // toMillis - выводит в UTC
        return reminderDate.toMillis();
    }

    let nextDayOffset = 1;

    const allDaysLength = ALL_DAYS.length;

    while (!activeDays.includes(ALL_DAYS[(currentDayIndex + nextDayOffset) % allDaysLength])) {
        nextDayOffset++;
    }

    // toMillis - выводит в UTC
    return now.plus({ days: nextDayOffset }).set({ hour, minute }).toMillis();
};