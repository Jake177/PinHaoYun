import {Manrope, Open_Sans, Roboto} from 'next/font/google';

const manrope = Manrope({
    subsets: ['latin'],
    weight: ['300', '400', '700'],
});

const open_sans = Open_Sans({
    subsets: ['latin'],
    weight: ['300', '400', '700'],
});

const roboto = Roboto({
    subsets: ['latin'],
    weight: ['300', '400', '700']
});


export { manrope, open_sans, roboto };