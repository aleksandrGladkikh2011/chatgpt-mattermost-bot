import { calculateNextRunDate } from '../time';

describe('calculateNextRunDate', () => {
    beforeAll(() => {
        // Используем фейковые таймеры
        jest.useFakeTimers();
    });
    
    afterAll(() => {
        // Возвращаем реальные таймеры
        jest.useRealTimers();
    });

    it('должен вернуть пн, сегодня суббота(5.04.25). Разрешённые пн, ср.', () => {
        const fixedDate = new Date(2025, 3, 5, 12, 0, 0);
        jest.setSystemTime(fixedDate);

        expect(calculateNextRunDate('12:00', ['mon', 'wed'])).toBe(1744016400000); // 2025-04-07T09:00:00.000Z - понедельник
    });

    it('должен вернуть сб, сегодня пятница(4.04.25). Разрешённые пт, сб.', () => {
        const fixedDate = new Date(2025, 3, 4, 12, 0, 0);
        jest.setSystemTime(fixedDate);

        expect(calculateNextRunDate('12:00', ['fri', 'sat'])).toBe(1743843600000); // 2025-04-05T09:00:00.000Z - суббота
    });

    it('должен вернуть пт, сегодня пятница(4.04.25). Разрешённые пт, сб.', () => {
        const fixedDate = new Date(2025, 3, 4, 5, 0, 0);
        jest.setSystemTime(fixedDate);

        expect(calculateNextRunDate('12:00', ['fri', 'sat'])).toBe(1743757200000); // 2025-04-04T09:00:00.000Z - пятница
    });

    it('должен вернуть пт, сегодня пятница(4.04.25). Разрешённые все будни', () => {
        const fixedDate = new Date(2025, 3, 4, 13, 0, 0);
        jest.setSystemTime(fixedDate);

        expect(calculateNextRunDate('12:00', [])).toBe(1744016400000); // 2025-04-07T09:00:00.000Z - понедельник
    });
});
